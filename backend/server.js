// backend/server.js
const express = require('express');
const cors = require('cors');
const bdd = require('./bdd');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Multer: asegurar carpeta uploads
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// funciones
function toISODate(ddmmyyyy) {
  // convierte dd/mm/yyyy a YYYY-MM-DD para MySQL
  const [d, m, y] = ddmmyyyy.split('/').map(v => v.trim());
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function parseTxt(content) {
  const lines = content
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let header = null;
  const details = [];
  let summary = null;

  for (const line of lines) {
    const parte = line.split('|').map(x => x.trim());
    const tag = parte[0];

    if (tag === 'E') {
      // E|RNC|BANCO|FECHA(dd/mm/yyyy)|MONTO|CTA_ORIGEN
      header = {
        rnc_empresa: parte[1],
        banco_destino: parte[2],
        fecha_pago: toISODate(parte[3]),
        monto_total: parseFloat(parte[4]),
        cuenta_origen: parte[5]
      };
    } else if (tag === 'D') {
      // D|CEDULA|CORREO|CTA|MONTO
      details.push({
        cedula: parte[1],
        correo: parte[2],
        cuenta_bancaria: parte[3],
        monto: parseFloat(parte[4])
      });
    } else if (tag === 'S') {
      summary = { cantidad_registros: parseInt(parte[1], 10) };
    }
  }

  return { header, details, summary };
}

// ---- rutas ----
app.get('/', (_req, res) => res.send('Servidor funcionando'));

// Subida de archivo .txt con Multer
app.post('/upload', upload.single('archivo'), (req, res) => {
  // validar subida
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se recibió archivo (campo "archivo")' });
  }

  // leer contenido
  fs.readFile(req.file.path, 'utf8', (err, data) => {
    if (err) {
      console.error('Error leyendo archivo:', err);
      return res.status(500).json({ ok: false, error: 'No se pudo leer el archivo en el servidor' });
    }

    try {
      const { header, details, summary } = parseTxt(data);

      if (!header) {
        return res.status(400).json({ ok: false, error: 'Encabezado E no encontrado en el TXT' });
      }

      const cantidad = summary ? summary.cantidad_registros : details.length;

      // Insertar en nomina
      const sqlNomina = `
        INSERT INTO nomina (rnc_empresa, banco_destino, fecha_pago, monto_total, cuenta_origen, cantidad_registros)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      const paramsNomina = [
        header.rnc_empresa,
        header.banco_destino,
        header.fecha_pago,
        header.monto_total,
        header.cuenta_origen,
        cantidad
      ];

      bdd.query(sqlNomina, paramsNomina, (errNom, result) => {
        if (errNom) {
          console.error('Error insertando nomina:', errNom.sqlMessage || errNom);
          return res.status(500).json({ ok: false, step: 'insert_nomina', error: errNom.sqlMessage || String(errNom) });
        }

        const id_nomina = result.insertId;

        if (details.length === 0) {
          return res.json({ ok: true, nomina_id: id_nomina, registros_insertados: 0 });
        }

        // Bulk insert de detalles
        const values = details.map(d => [
          id_nomina, 
          d.cedula, 
          d.correo && d.correo.length > 0 ? d.correo : null, 
          d.cuenta_bancaria, 
          d.monto
        ]);
        const sqlDetalle = `
          INSERT INTO detalle (id_nomina, cedula, correo, cuenta_bancaria, monto)
          VALUES ?
        `;
        bdd.query(sqlDetalle, [values], (errDet, _resDet) => {
          if (errDet) {
            console.error('Error insertando detalle:', errDet.sqlMessage || errDet);
            return res.status(500).json({ ok: false, step: 'insert_detalle', error: errDet.sqlMessage || String(errDet) });
          }
          return res.json({ ok: true, nomina_id: id_nomina, registros_insertados: details.length });
        });
      });
    } catch (e) {
      console.error('Error parseando/procesando TXT:', e);
      return res.status(400).json({ ok: false, error: 'Formato del TXT inválido o inesperado' });
    }
  });
});


app.use((_req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada' }));

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
