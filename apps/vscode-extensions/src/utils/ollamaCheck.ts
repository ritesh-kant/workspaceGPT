export async function isOllamaRunningCheck(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/version');
    return response.ok;
  } catch (error) {
    return false;
  }
}