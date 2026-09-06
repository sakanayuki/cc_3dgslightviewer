import { writeFileSync } from 'node:fs';

/**
 * 動作確認用の合成 3DGS PLY を作る (INRIA 形式 / binary_little_endian)。
 *
 *   node tools/make-test-ply.mjs <出力先> [splat数] [SH次数] [形状]
 *   形状: slab (既定, 軸ごとに寸法が異なる板状) / cube (等方な立方体)
 *
 * slab は軸ごとに広がりが違うため、ギズモの軸スナップや自動フィットの
 * 確認に向く。cube はどの軸から見ても同じに見えるので、視点の変化を
 * 目視で確かめる用途には使えない。
 */
export function makePly(n, shDegree, shape = 'slab') {
  const restCount = shDegree === 3 ? 45 : shDegree === 2 ? 24 : shDegree === 1 ? 9 : 0;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  for (let i = 0; i < restCount; i++) props.push(`f_rest_${i}`);
  props.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');

  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n` +
    props.map((p) => `property float ${p}`).join('\n') +
    `\nend_header\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const stride = props.length * 4;
  const body = Buffer.alloc(n * stride);

  // 軸ごとの広がり。slab は X:Y:Z = 10:1.5:5 と大きく異なる
  const extent = shape === 'cube' ? [5, 5, 5] : [10, 1.5, 5];

  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (let i = 0; i < n; i++) {
    const o = i * stride;
    let k = 0;
    const put = (v) => { body.writeFloatLE(v, o + k); k += 4; };

    put((rnd() * 2 - 1) * extent[0]);
    put((rnd() * 2 - 1) * extent[1]);
    put((rnd() * 2 - 1) * extent[2]);
    put(0); put(0); put(0);                                     // normals (未使用)
    put(rnd() * 2 - 1); put(rnd() * 2 - 1); put(rnd() * 2 - 1); // f_dc
    for (let j = 0; j < restCount; j++) put(rnd() * 0.6 - 0.3); // f_rest
    put(rnd() * 6 - 2);                                         // opacity (logit)
    put(Math.log(0.02 + rnd() * 0.25));                         // scale (log)
    put(Math.log(0.02 + rnd() * 0.25));
    put(Math.log(0.02 + rnd() * 0.25));
    put(1); put(0); put(0); put(0);                             // rot (w,x,y,z)
  }
  return Buffer.concat([headerBuf, body]);
}

if (process.argv[2]) {
  const out = process.argv[2];
  const n = Number(process.argv[3] ?? 5000);
  const deg = Number(process.argv[4] ?? 3);
  const shape = process.argv[5] ?? 'slab';
  writeFileSync(out, makePly(n, deg, shape));
  console.log(`wrote ${out} (${n} splats, SH deg ${deg}, shape ${shape})`);
}
