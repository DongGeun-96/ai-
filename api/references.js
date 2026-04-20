import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send } from './_lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFS_PATH = path.join(__dirname, '..', 'knowledge', 'references.json');

export default function handler(req, res) {
  try {
    const raw = fs.readFileSync(REFS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return send(res, 200, data);
  } catch {
    return send(res, 200, {});
  }
}
