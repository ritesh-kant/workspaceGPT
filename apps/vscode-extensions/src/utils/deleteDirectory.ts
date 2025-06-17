import fs from 'fs';
import { promisify } from 'util';

export async function deleteDirectory(dirPath: string): Promise<void> {
  try {
    if (fs.existsSync(dirPath)) {
      await promisify(fs.rm)(dirPath, { recursive: true, force: true });
      console.log(`Deleted directory: ${dirPath}`);
    }
  } catch (error) {
    console.error('Error deleting directory:', error);
    throw error;
  }
}
