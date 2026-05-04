import keytar from 'keytar';

const SERVICE = 'MNNClipNamer';
const ACCOUNT = 'openai-api-key';

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await keytar.deletePassword(SERVICE, ACCOUNT);
    return;
  }
  await keytar.setPassword(SERVICE, ACCOUNT, trimmed);
}

export async function getApiKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT);
}

export async function hasApiKey(): Promise<boolean> {
  const k = await keytar.getPassword(SERVICE, ACCOUNT);
  return !!k;
}
