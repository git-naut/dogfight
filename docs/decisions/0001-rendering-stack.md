# 0001 レンダリングスタックに WebGL2 を選ぶ

2026-08-16 決定。**2026-08-31 に `0010-webgpu-tsl.md` が置き換えた。**当時の判断として残す。

置き換えの理由は下の「移行の条件」が満たされていたこと。しかも満たされたのはこの文書を書いた 9 か月前で、Phase 2 で入れた `@takram/three-atmosphere@0.19.1` は最初から `./webgpu` を export していた。**条件を書いたあと、条件が満たされたかを誰も確かめなかった。**

## 決めたこと

WebGL2 + pmndrs `postprocessing` + `@takram/three-atmosphere` で組む。WebGPURenderer と TSL は採用しない。

## なぜ WebGPU を見送ったか

Three.js は r171 以降 WebGPURenderer が production-ready で、Safari 26 も WebGPU に対応した。TSL を使えばシェーダを型のある TypeScript として書けるため、エージェント主導の開発とは相性がよい。当初はこちらを第一候補にしていた。

取り下げた理由は `@takram/three-atmosphere` にある。このライブラリは Precomputed Atmospheric Scattering の実装だが、現時点では GLSL で書かれており pmndrs の `postprocessing` を前提とする。TSL と WebGPU への対応は計画段階に留まる。

飛行ゲームは画面の大半が空になるため、大気散乱の品質が見た目を左右する。ここを自前実装に置き換えると Phase 2 の工数が膨らみ、しかもライブラリより見劣りする可能性が高い。一方でボリュメトリック雲のレイマーチングは WebGL2 の GLSL でも書ける。

品質への寄与が大きい側でライブラリを取り、書ける側を自前にする。この配分から WebGL2 を選んだ。

## 何を捨てたか

TSL による型付きシェーダ。GLSL は文字列として扱うことになり、コンパイルエラーは実行時まで出ない。WebGPU のポストプロセススタックにある SSGI と改良版 DoF も使えない。

## 移行の条件

`@takram/three-atmosphere` が WebGPU と TSL に対応した時点で再検討する。それまでシェーダは移行しやすい形で書く。ユニフォーム名は TSL のノード名へ写しやすい命名にする。関数は機能単位で分割し、丸ごと書き直さずに済む粒度を保つ。

## 参照

- [Three.js WebGPURenderer の現状](https://www.utsubo.com/blog/threejs-2026-what-changed)
- [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial)
- [雲のレイマーチング参照実装](https://github.com/CK42BB/procedural-clouds-threejs)
