# Custom schematics

Drop `.schem`, `.litematic`, `.schematic`, `.nbt`, `.cbschem` or native `.json`
designs in this folder, then run `schematics scan` (or use **Building workspace →
Import designs → Rescan folder** in the dashboard).

- Files are converted lazily into `.cache/`. The originals are never modified.
- Identical content and duplicate geometry are rejected with a reason rather
  than counted twice. Rotations and mirrors do not create new entries.
- `index.json` is generated metadata; imported files and the cache stay local
  and are not committed.
