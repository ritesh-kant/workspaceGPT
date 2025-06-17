import fs from 'fs';
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.promises.access(dirPath).catch(async () => {
      await fs.promises.mkdir(dirPath, { recursive: true });
    });
  } catch (error) {
    console.error('Error creating directory:', error);
    throw error;
  }
}
