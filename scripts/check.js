const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js', 'controller.js', ...['scripts', 'tests'].flatMap(directory =>
    fs.readdirSync(path.join(root, directory)).filter(file => file.endsWith('.js')).map(file => `${directory}/${file}`)
)];
for (const file of files) {
    new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const [index, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], { filename: `index.html:script-${index + 1}` });
}
console.log(`Syntax checked ${files.length} JavaScript files and the inline renderer script.`);
