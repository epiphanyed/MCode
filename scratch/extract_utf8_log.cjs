const fs = require('fs');
const path = require('path');

const logPath = 'd:\\work\\void\\log.txt';
const outPath = 'd:\\work\\void\\scratch\\utf8_log_tail.txt';

try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const tailLines = lines.slice(-250).join('\n'); // grab last 250 lines
    fs.writeFileSync(outPath, tailLines, 'utf8');
    console.log('Successfully wrote tail of log.txt in UTF-8 to scratch/utf8_log_tail.txt');
} catch (e) {
    console.error('Error:', e);
}
