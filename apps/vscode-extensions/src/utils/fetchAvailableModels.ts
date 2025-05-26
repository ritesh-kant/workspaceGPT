import OpenAI from 'openai';

export async function fetchAvailableModels(baseURL: string, apiKey: string) {
  try {
    const openai = new OpenAI({
      apiKey,
      baseURL,
    });

    const response = await openai.models.list();
    return response.data.map((model) => ({id: model.id}));
  } catch (error: any) {
    console.error('Error fetching models:', error);
    throw new Error('Invalid API Key');
  }
}
