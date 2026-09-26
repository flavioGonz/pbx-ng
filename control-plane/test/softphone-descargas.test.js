'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../softphone-descargas');

test('la version sale del nombre del apk', () => {
  assert.equal(d.versionDeNombre('pbxng-softphone-0.6.0.apk'), '0.6.0');
  assert.equal(d.versionDeNombre('PBX-NG_1.2.apk'), '1.2');
  assert.equal(d.versionDeNombre('softphone.apk'), '');
});

test('1.10.0 es mas nuevo que 1.9.3 (ordenar por texto lo daba al reves)', () => {
  assert.ok(d.compararVersiones('1.10.0', '1.9.3') > 0);
  assert.equal(d.elegirApk(['pbxng-1.9.3.apk', 'pbxng-1.10.0.apk']), 'pbxng-1.10.0.apk');
});

test('sin apk en el directorio, android queda no disponible y Windows no se entera', () => {
  const r = d.armar({ latestYml: 'version: 0.6.0\npath: Setup 0.6.0.exe\n', nombres: ['Setup 0.6.0.exe', 'latest.yml'], tamano: () => 120 });
  assert.equal(r.available, true);
  assert.equal(r.platform, 'windows');
  assert.equal(r.android.available, false);
});

test('el apk se ofrece aunque no haya instalador de Windows', () => {
  const r = d.armar({ nombres: ['pbxng-0.6.0.apk'], tamano: () => 42 });
  assert.equal(r.available, false);
  assert.equal(r.android.available, true);
  assert.equal(r.android.url, '/descargas/softphone/pbxng-0.6.0.apk');
});

test('los espacios del nombre viajan escapados en la URL', () => {
  const r = d.armar({ latestYml: 'version: 0.6.0\npath: PBX-NG Setup 0.6.0.exe\n', nombres: [], tamano: () => 1 });
  assert.equal(r.url, '/descargas/softphone/PBX-NG%20Setup%200.6.0.exe');
});

test('si el archivo que anuncia latest.yml no esta, no se ofrece la descarga', () => {
  const r = d.armar({ latestYml: 'version: 0.6.0\npath: Setup 0.6.0.exe\n', nombres: [], tamano: () => null });
  assert.equal(r.available, false);
  assert.match(r.reason, /Setup/);
});
