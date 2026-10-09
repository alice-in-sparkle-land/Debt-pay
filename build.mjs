// Combines src/ into one self-contained page: site/public/tra-no.html
import { readFileSync, writeFileSync } from 'node:fs';
const r = f => readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
const html = r('shell.html')
  .replace('/*CSS*/', () => r('app.css'))
  .replace('/*JS*/', () => r('scene.js') + '\n' + r('app.js'));
writeFileSync(new URL('./public/tra-no.html', import.meta.url), html);
console.log('built', html.length, 'bytes');
