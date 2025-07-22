# Extract GLB

Extracts truncated binary data of a GLB or GLTF + binary files, for educational/debugging purposes.

## Usage

Write the input file in `extract-glb.ts`, then run `bun extract-glb.ts` (or other runtimes that support TS).

## Result

See `cube.glb.json` for an example of result.

## Gltf.report Alternative

Alternatively, to list the content of an attribute such as `POSITION`, run the following snippet in the script tab of [gltf.report](https://gltf.report/):

```js
for (const mesh of document.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    console.log(position.getArray());
  }
}
```

## Disclaimer

Vibe-coded for myself. Use at your own risk.
