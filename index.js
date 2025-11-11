import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";
import {v4 as uuidv4} from "uuid";
import mime from "mime-types";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "password";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive: true});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}));

app.use("/", express.static(path.join(__dirname, "public")));

// 🔐 Auth simple
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
        res.set("WWW-Authenticate", 'Basic realm="Uploader"');
        return res.status(401).send("Authentication required");
    }

    const base64 = authHeader.split(" ")[1];
    const [user, pass] = Buffer.from(base64, "base64").toString().split(":");

    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

    res.set("WWW-Authenticate", 'Basic realm="Uploader"');
    return res.status(401).send("Invalid credentials");
}

// ⚙️ Multer config (no size limit)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const tmp = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, tmp);
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Only image files are allowed"));
    },
});

// 🔹 Upload
app.post("/upload", requireAuth, upload.single("file"), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({error: "No file uploaded"});

        let customId = req.body.id || req.query.id || null;

        if (customId) {
            if (!/^[a-zA-Z0-9_-]+$/.test(customId)) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({error: "Invalid ID"});
            }

            const jsonPath = path.join(UPLOAD_DIR, `${customId}.json`);
            if (fs.existsSync(jsonPath)) {
                fs.unlinkSync(req.file.path);
                return res.status(409).json({error: "This ID already exists"});
            }
        }

        const id = customId || uuidv4();
        const ext = path.extname(req.file.originalname).toLowerCase();
        const filename = `${id}${ext}`;
        const destPath = path.join(UPLOAD_DIR, filename);

        fs.renameSync(req.file.path, destPath);

        const meta = {
            id,
            filename,
            originalName: req.file.originalname,
            uploadedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta));

        const imageUrl = `${BASE_URL}/i/${id}`;
        const viewUrl = `${BASE_URL}/view/${id}`;
        return res.json({id, url: imageUrl, viewUrl});
    } catch (err) {
        console.error(err);
        return res.status(500).json({error: "Server error"});
    }
});

// 🔹 Servir une image sans extension
app.get("/i/:id", (req, res) => {
    const id = req.params.id;
    const jsonPath = path.join(UPLOAD_DIR, `${id}.json`);
    if (!fs.existsSync(jsonPath)) return res.status(404).send("Not found");

    const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const filePath = path.join(UPLOAD_DIR, meta.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File missing");

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    const contentType = mime.lookup(filePath) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    fs.createReadStream(filePath).pipe(res);
});

// 🔹 Page d’affichage / embed Discord
app.get("/view/:id", (req, res) => {
    const id = req.params.id;
    const jsonPath = path.join(UPLOAD_DIR, `${id}.json`);
    if (!fs.existsSync(jsonPath)) return res.status(404).send("Not found");

    const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const imageUrl = `${BASE_URL}/i/${id}`;

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(meta.originalName)}</title>
  <meta property="og:title" content="${escapeHtml(meta.originalName)}">
  <meta property="og:image" content="${imageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <style>
    body { font-family: Arial; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#f4f4f4 }
    img { max-width:90%; border-radius:8px; box-shadow:0 0 12px rgba(0,0,0,.15); }
  </style>
</head>
<body>
  <img src="${imageUrl}" alt="${escapeHtml(meta.originalName)}">
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
});

// 🔹 Nouvelle route : galerie
app.get("/gallery", (req, res) => {
    const files = fs
        .readdirSync(UPLOAD_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => {
            const meta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), "utf8"));
            return {
                ...meta,
                imageUrl: `${BASE_URL}/i/${meta.id}`,
                viewUrl: `${BASE_URL}/view/${meta.id}`,
            };
        })
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Galerie d'images</title>
  <style>
    body { font-family: Arial; background:#f4f4f4; margin:0; padding:24px; }
    h1 { text-align:center; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px; margin-top:24px; }
    .card { background:white; padding:12px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,.08); text-align:center; }
    img { max-width:100%; border-radius:6px; height:160px; object-fit:cover; }
    .meta { font-size:14px; color:#555; margin-top:6px; }
    a.btn { display:inline-block; margin:4px 4px 0; padding:6px 10px; border-radius:6px; background:#4f46e5; color:white; text-decoration:none; font-size:13px; }
  </style>
</head>
<body>
  <h1>Galerie d'images</h1>
  <div style="text-align:center; margin-bottom:16px;">
  <a href="/index.html" class="btn" style="background:#10b981;">Upload</a>
</div>

  <div class="grid">
  ${files.map(f => `
    <div class="card">
      <img src="${f.imageUrl}" alt="${escapeHtml(f.originalName)}">
      <div class="meta"><strong>${escapeHtml(f.id)}</strong></div>
      <div class="meta">${escapeHtml(f.originalName)}</div>
      <div class="meta">${new Date(f.uploadedAt).toLocaleString()}</div>
      <div>
        <div>
          <a class="btn" href="${f.imageUrl}" target="_blank">Ouvrir</a>
          <a class="btn" href="${f.viewUrl}" target="_blank">Embed</a>
          <button class="btn copy-btn" data-url="${f.imageUrl}">Copier le lien</button>
          <button class="btn delete-btn" data-id="${f.id}" style="background:#ef4444;">Supprimer</button>
        </div>
      </div>
    </div>`).join('')}
</div>

<script>
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.getAttribute('data-url');
    navigator.clipboard.writeText(url).then(() => {
      const old = btn.textContent;
      btn.textContent = 'Copié !';
      setTimeout(() => btn.textContent = old, 1300);
    });
  });
});

document.querySelectorAll('.delete-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if(!confirm("Voulez-vous vraiment supprimer cette image ?")) return;

    const id = btn.getAttribute('data-id');
    try {
      const user = prompt("Admin username:");
      const pass = prompt("Admin password:");
      const credentials = btoa(unescape(encodeURIComponent(user + ":" + pass)));
      const res = await fetch("/delete/" + id, {
        method: "DELETE",
        headers: {
          'Authorization': 'Basic ' + credentials
        }
      });
      const j = await res.json();
      if(res.ok) {
        btn.closest('.card').remove(); // supprime visuellement la card
      } else {
        alert("Erreur: " + j.error);
      }
    } catch(err) {
      alert("Erreur: " + err.message);
    }
  });
});
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
});

// 🔹 Supprimer une image (auth requise)
app.delete("/delete/:id", requireAuth, (req, res) => {
    const id = req.params.id; // <- c'est ici qu'on récupère l'id
    const jsonPath = path.join(UPLOAD_DIR, `${id}.json`);
    if (!fs.existsSync(jsonPath)) return res.status(404).json({error: "Not found"});

    const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const filePath = path.join(UPLOAD_DIR, meta.filename);

    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.unlinkSync(jsonPath);
        return res.json({ok: true});
    } catch (err) {
        console.error(err);
        return res.status(500).json({error: "Failed to delete"});
    }
});


function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

app.get("/health", (req, res) => res.json({ok: true}));

app.listen(PORT, () => console.log(`🚀 Server running at ${BASE_URL}`));
