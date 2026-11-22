#!/usr/bin/env node
// Copies the Gift animation engine (Python modules + bundled character art and font) from a
// Gift checkout into engines/animation and pins every file in MANIFEST.json. DODO-owned files
// (dodo_bridge.py, README.md, requirements.txt) are never touched. Run explicitly:
//   node scripts/vendor-animation.mjs --from <path to the Gift project>
// Packaging tests re-hash the vendored files against the manifest, so hand edits are caught.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ENGINE_FILES = [
  'animate.py', 'banner_render.py', 'caption.py', 'character_animation.py', 'exporters.py', 'foot_lock_review.py',
  'fox_girl_rig.py', 'image_animation.py', 'loop_review.py', 'motion_physics.py', 'orange_cat_rig.py',
  'pose_sheet.py', 'rig_animation.py', 'rig_presets.py', 'scene_animation.py', 'smooth.py', 'solar_scene.py',
  'sprite_animation.py', 'video_export.py',
  'CREDITS.md', 'assets/OFL.txt', 'assets/Sarabun-Bold.ttf',
  'assets/characters/orange_cat.png', 'assets/characters/fox_girl.png',
  ...['space', 'sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].map(name => `assets/solar_system/${name}.webp`),
];

const args = process.argv.slice(2);
const from = args[0] === '--from' && args[1] ? path.resolve(args[1]) : undefined;
if (!from || args.length !== 2) {
  console.error('Usage: node scripts/vendor-animation.mjs --from <path to the Gift project>');
  process.exit(1);
}
const destination = path.resolve('engines/animation');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = {};
for (const name of ENGINE_FILES) {
  const source = path.join(from, name);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file in the Gift project`);
  const target = path.join(destination, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The repository stores text with LF (.gitattributes). Normalize here so the pinned hashes
  // match every checkout and the packed tarball, whatever line endings the Gift copy has.
  if (/\.(?:py|md|txt)$/.test(name)) fs.writeFileSync(target, fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n'));
  else fs.copyFileSync(source, target);
  files[name] = sha256(target);
}
fs.writeFileSync(path.join(destination, 'MANIFEST.json'), `${JSON.stringify({
  source: 'Gift animation engine', vendoredBy: 'scripts/vendor-animation.mjs', files,
}, null, 2)}\n`);
console.log(`[dodo] vendor-animation: pinned ${ENGINE_FILES.length} Gift engine files in engines/animation/MANIFEST.json`);
