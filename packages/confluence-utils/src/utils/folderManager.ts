import fs from 'fs';

export function createFolders(DIRS: string[]): void {
    const directories = [...DIRS];

    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`✅ Created directory: ${dir}`);
        }
    });
}