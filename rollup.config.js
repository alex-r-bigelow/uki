import pkg from './package.json';
import json from '@rollup/plugin-json';
import execute from 'rollup-plugin-execute';

// Derive some of the configuration from package.json
const peerDependencies = Object.keys(pkg.peerDependencies);
const allExternals = peerDependencies.concat(
  Object.keys(pkg.dependencies || {})).concat(
  Object.keys(pkg.devDependencies || {}));

// Basic build formats, without minification
export default [
  // ES Module
  {
    input: 'src/module.js',
    output: {
      file: pkg.module,
      format: 'es'
    },
    external: allExternals,
    plugins: [
      json(),
      execute('sleep 1 && ls -d examples/*/ | xargs -n 1 cp -v dist/uki.esm.js')
    ]
  }
];
