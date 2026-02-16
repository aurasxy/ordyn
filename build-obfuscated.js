#!/usr/bin/env node
/**
 * SOLUS Build Script with Code Obfuscation
 * 
 * This script:
 * 1. Copies source files to a build directory
 * 2. Obfuscates main.js (Electron main process)
 * 3. Extracts, obfuscates, and re-embeds JS from index.html
 * 4. Outputs protected files ready for electron-builder
 * 
 * Usage:
 *   npm run build:protected
 *   
 * Or directly:
 *   node build-obfuscated.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Check if javascript-obfuscator is installed
try {
  require.resolve('javascript-obfuscator');
} catch (e) {
  console.log('📦 Installing javascript-obfuscator...');
  execSync('npm install javascript-obfuscator --save-dev', { stdio: 'inherit' });
}

const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_DIR = path.join(__dirname, 'src');
const BUILD_DIR = path.join(__dirname, 'src-protected');
const BACKUP_DIR = path.join(__dirname, 'src-backup');

// Obfuscation settings - balanced between protection and performance
const OBFUSCATION_OPTIONS = {
  // Compact output
  compact: true,
  
  // Control flow obfuscation (makes logic harder to follow)
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  
  // Dead code injection (adds fake code)
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  
  // Debug protection (crashes if DevTools opened)
  debugProtection: false, // Set to true for release, false for testing
  debugProtectionInterval: 0,
  
  // Disable console output in production
  disableConsoleOutput: false, // Set to true for release
  
  // Identifier renaming
  identifierNamesGenerator: 'hexadecimal',
  
  // Don't rename globals (breaks Electron APIs)
  renameGlobals: false,
  
  // Self-defending (crashes if code modified)
  selfDefending: false, // Can cause issues, keep false
  
  // String obfuscation
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  
  // Transform object keys
  transformObjectKeys: true,
  
  // Unicode escape sequences
  unicodeEscapeSequence: false,
  
  // Target environment
  target: 'node', // For main.js (Electron main process)
  
  // Preserve some functionality
  reservedNames: [
    'ipcMain',
    'ipcRenderer', 
    'BrowserWindow',
    'app',
    'dialog',
    'shell',
    'Menu',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'process',
    'Buffer',
    'electron'
  ],
  reservedStrings: [
    'electron',
    'ipcMain',
    'ipcRenderer'
  ]
};

// Browser-specific options for index.html JS
const BROWSER_OBFUSCATION_OPTIONS = {
  ...OBFUSCATION_OPTIONS,
  target: 'browser',
  reservedNames: [
    'window',
    'document',
    'api',
    'Chart',
    'html2canvas',
    'localStorage',
    'sessionStorage',
    'fetch',
    'console',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'Promise',
    'JSON',
    'Array',
    'Object',
    'String',
    'Number',
    'Boolean',
    'Date',
    'Math',
    'RegExp',
    'Error',
    'Map',
    'Set',
    'alert',
    'confirm'
  ]
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function backupOriginal() {
  console.log('📁 Backing up original source...');
  ensureDir(BACKUP_DIR);
  
  if (fs.existsSync(path.join(SRC_DIR, 'main.js'))) {
    fs.copyFileSync(
      path.join(SRC_DIR, 'main.js'),
      path.join(BACKUP_DIR, 'main.js')
    );
  }
  if (fs.existsSync(path.join(SRC_DIR, 'index.html'))) {
    fs.copyFileSync(
      path.join(SRC_DIR, 'index.html'),
      path.join(BACKUP_DIR, 'index.html')
    );
  }
}

function obfuscateMainJS() {
  console.log('🔐 Obfuscating main.js...');
  
  const mainPath = path.join(SRC_DIR, 'main.js');
  const code = fs.readFileSync(mainPath, 'utf8');
  
  const startTime = Date.now();
  const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);
  const elapsed = Date.now() - startTime;
  
  const outputPath = path.join(BUILD_DIR, 'main.js');
  ensureDir(BUILD_DIR);
  fs.writeFileSync(outputPath, obfuscated.getObfuscatedCode());
  
  const originalSize = Buffer.byteLength(code, 'utf8');
  const obfuscatedSize = Buffer.byteLength(obfuscated.getObfuscatedCode(), 'utf8');
  
  console.log(`   ✓ Original: ${(originalSize / 1024).toFixed(1)} KB`);
  console.log(`   ✓ Obfuscated: ${(obfuscatedSize / 1024).toFixed(1)} KB`);
  console.log(`   ✓ Time: ${elapsed}ms`);
}

function obfuscateIndexHTML() {
  console.log('📄 Copying index.html (skipping JS obfuscation for compatibility)...');
  
  const htmlPath = path.join(SRC_DIR, 'index.html');
  const outputPath = path.join(BUILD_DIR, 'index.html');
  
  ensureDir(BUILD_DIR);
  fs.copyFileSync(htmlPath, outputPath);
  
  console.log('   ✓ index.html copied');
}

function copyOtherFiles() {
  console.log('📄 Copying other files...');
  
  // Copy preload.js if it exists
  const preloadSrc = path.join(SRC_DIR, 'preload.js');
  if (fs.existsSync(preloadSrc)) {
    const preloadCode = fs.readFileSync(preloadSrc, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(preloadCode, OBFUSCATION_OPTIONS);
    fs.writeFileSync(path.join(BUILD_DIR, 'preload.js'), obfuscated.getObfuscatedCode());
    console.log('   ✓ preload.js (obfuscated)');
  }
  
  // Copy and obfuscate license.js and telemetry.js
  ['license.js', 'telemetry.js'].forEach(file => {
    const filePath = path.join(SRC_DIR, file);
    if (fs.existsSync(filePath)) {
      const code = fs.readFileSync(filePath, 'utf8');
      const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);
      fs.writeFileSync(path.join(BUILD_DIR, file), obfuscated.getObfuscatedCode());
      console.log(`   ✓ ${file} (obfuscated)`);
    }
  });

  // Copy any CSS files
  fs.readdirSync(SRC_DIR).forEach(file => {
    if (file.endsWith('.css')) {
      fs.copyFileSync(
        path.join(SRC_DIR, file),
        path.join(BUILD_DIR, file)
      );
      console.log(`   ✓ ${file}`);
    }
  });

  // Copy vendor directory (bundled CDN libraries)
  const vendorSrc = path.join(SRC_DIR, 'vendor');
  const vendorDest = path.join(BUILD_DIR, 'vendor');
  if (fs.existsSync(vendorSrc)) {
    ensureDir(vendorDest);
    fs.readdirSync(vendorSrc).forEach(file => {
      fs.copyFileSync(path.join(vendorSrc, file), path.join(vendorDest, file));
      console.log(`   ✓ vendor/${file}`);
    });
  }
}

function updatePackageJson() {
  console.log('📦 Updating package.json for protected build...');
  
  // Create a modified package.json that points to protected source
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  
  // Backup original
  fs.writeFileSync(
    path.join(__dirname, 'package.original.json'),
    JSON.stringify(pkg, null, 2)
  );
  
  // Point to protected source
  pkg.main = 'src-protected/main.js';
  pkg.build.files = [
    'src-protected/**/*',
    'assets/**/*',
    '!valid-licenses.json'
  ];

  // Ensure extraResources includes product images and SKU mappings
  pkg.build.extraResources = [
    {
      "from": "sku-mappings.json",
      "to": "sku-mappings.json"
    },
    {
      "from": "product-images",
      "to": "product-images"
    }
  ];
  
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('   ✓ package.json updated to use src-protected');
}

function restorePackageJson() {
  const originalPath = path.join(__dirname, 'package.original.json');
  const pkgPath = path.join(__dirname, 'package.json');
  
  if (fs.existsSync(originalPath)) {
    fs.copyFileSync(originalPath, pkgPath);
    fs.unlinkSync(originalPath);
    console.log('   ✓ package.json restored');
  }
}

function printSummary() {
  console.log('\n' + '═'.repeat(50));
  console.log('✅ BUILD COMPLETE');
  console.log('═'.repeat(50));
  console.log(`
Protected files are in: ${BUILD_DIR}

Next steps:
  1. Run: npm run build:win (or build:mac/build:linux)
  2. Find installer in: dist/

To restore original package.json:
  node build-obfuscated.js --restore
  
To test protected version before building:
  npm run start:protected
`);
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--restore')) {
    restorePackageJson();
    console.log('✅ Package.json restored to original');
    return;
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log('🔒 SOLUS Code Protection Build');
  console.log('═'.repeat(50) + '\n');
  
  const startTime = Date.now();
  
  try {
    backupOriginal();
    obfuscateMainJS();
    obfuscateIndexHTML();
    copyOtherFiles();
    updatePackageJson();
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n⏱ Total build time: ${totalTime}s`);
    
    printSummary();
  } catch (err) {
    console.error('\n❌ Build failed:', err.message);
    process.exit(1);
  } finally {
    restorePackageJson();
  }
}

main();
