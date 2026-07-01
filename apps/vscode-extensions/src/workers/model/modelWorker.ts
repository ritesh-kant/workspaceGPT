import { parentPort, workerData } from 'worker_threads';
import { createStructuredPrompt } from '../../utils/promptTemplates';
import { MODEL_PROVIDERS } from '../../../constants';
import OpenAI from 'openai';
import { EmbeddingSearchResult } from 'src/types/types';
import { withKeyFailover } from '../../utils/apiKeyFailover';

interface WorkerData {
  prompt: string;
  searchResults: EmbeddingSearchResult[];
  modelId?: string;
  chatHistory?: string;
  provider?: string;
  apiKey?: string;
  /** All configured keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
  currentUserName?: string;
  currentSprint?: { name: string; iterationPath: string; startDate: string; endDate: string } | null;
}

const {
  prompt,
  searchResults,
  modelId,
  chatHistory,
  provider,
  apiKey,
  apiKeys,
  currentUserName,
  currentSprint,
} = workerData as WorkerData;

// Prefer the full key list; fall back to the single legacy key.
const failoverKeys = apiKeys && apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];

async function generateResponse(): Promise<void> {
  try {
    const structuredPrompt = createStructuredPrompt(searchResults, prompt, chatHistory, currentUserName, currentSprint);

    // Get provider configuration
    const providerConfig = MODEL_PROVIDERS.find(p => p.MODEL_PROVIDER === provider);
    if (!providerConfig || !modelId || !failoverKeys.length) {
      throw new Error(`Provider ${provider} or modelId not found`);
    }

    await generateWithOpenAIStream(structuredPrompt, modelId, providerConfig.BASE_URL, failoverKeys);
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function generateWithOpenAIStream(prompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  // Create the stream with key failover. A 429 surfaces at creation (before any
  // chunk), so rotating to the next key here is safe — no partial output yet.
  const stream = await withKeyFailover(apiKeys, (apiKey) => {
    const openai = new OpenAI({ apiKey, baseURL });
    return openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    });
  });

  let fullContent = '';
  let thinkingDone = false;
  let isCheckingThink = true;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullContent += delta;

      // Check for <think> tag at the very start
      if (isCheckingThink) {
        if (fullContent.length >= 7) {
          isCheckingThink = false;
          if (!fullContent.startsWith('<think>')) {
            thinkingDone = true;
            // Not a thinking model, send everything we buffered so far
            parentPort?.postMessage({ type: 'chunk', content: fullContent });
            continue;
          }
        } else {
          // Still accumulating the first 7 chars
          continue;
        }
      }

      // Strip <think>...</think> blocks - only send content after thinking is done
      if (!thinkingDone) {
        const thinkEnd = fullContent.indexOf('</think>');
        if (thinkEnd !== -1) {
          thinkingDone = true;
          const afterThink = fullContent.substring(thinkEnd + 8).trim();
          if (afterThink) {
            parentPort?.postMessage({ type: 'chunk', content: afterThink });
          }
        }
        // If still inside <think> block, don't send anything yet
        continue;
      }

      // Send chunk to UI
      parentPort?.postMessage({ type: 'chunk', content: delta });
    }
  }

  // Handle case where stream ended before 7 chars
  if (isCheckingThink) {
    parentPort?.postMessage({ type: 'chunk', content: fullContent });
  }

  // Signal completion
  parentPort?.postMessage({ type: 'done', content: fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });
}

// Start processing
generateResponse();
