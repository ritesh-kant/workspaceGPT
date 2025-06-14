// scripts/patch-xenova-transformers.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(
  __dirname,
  '../..',
  'node_modules',
  '@xenova',
  'transformers',
  'src',
  'utils',
  'image.js'
);

if (!fs.existsSync(filePath)) {
  console.warn('❌ Could not find image.js. Skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

// Patch the sharp import
// Only comment out the "import sharp" line if it's not already commented
if (!/^\s*\/\/\s*import\s+sharp\s+from\s+['"]sharp['"]/.test(content)) {
  content = content.replace(
    /^\s*import\s+sharp\s+from\s+['"]sharp['"];?/m,
    `// import sharp from 'sharp';\nconst sharp = null;`
  );
}

// Patch the "throw new Error" line
// Only comment out the "throw new Error" line if it's not already commented
if (!/^\s*\/\/\s*throw\s+new\s+Error\(['"`]Unable to load image processing library\./.test(content)) {
  content = content.replace(
    /^\s*throw\s+new\s+Error\(['"`]Unable to load image processing library\..*['"`]\);?/m,
    `// throw new Error('Unable to load image processing library.');`
  );
}

fs.writeFileSync(filePath, content, 'utf8');

console.log('✅ Patched @xenova/transformers/src/utils/image.js');