const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = path.join(os.tmpdir(), 'trackmania-maps');

console.log('Temp Dir:', tempDir);
try {
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`Removed Trackmania temp maps: ${tempDir}`);
    } else {
        console.log(`Trackmania temp maps folder does not exist: ${tempDir}`);
    }
} catch (error) {
    console.error(`Failed to clean Trackmania temp maps: ${error.message}`);
    process.exit(1);
}
