// One-time import: reads the original .xlsm and seeds SQLite as workbook #1.
// Run with: npm run import
const fs = require('fs');
const path = require('path');
const { createWorkbook } = require('../lib/db');
const { importWorkbook } = require('../lib/xlsx-io');

const FILE = path.join(__dirname, '..', '樣品進度File mẫu tiến độ.xlsm');

const workbookId = createWorkbook('Sample Sheet');
importWorkbook(fs.readFileSync(FILE), workbookId);
console.log(`Imported into workbook #${workbookId}.`);
