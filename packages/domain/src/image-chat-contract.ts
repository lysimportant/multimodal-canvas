/** Known Gemini image-chat models on the New API gateway; Imagen is separate. */
export function isGeminiChatImageModel(modelAlias: string | undefined): boolean {
  const model = modelAlias?.trim().toLowerCase() ?? '';
  return (
    /^gemini-[a-z0-9._-]*-image(?:-[a-z0-9._-]+)?$/.test(model) ||
    /^gemini-nano-banana(?:-[a-z0-9._-]+)?$/.test(model) ||
    /^nano-banana(?:-[a-z0-9._-]+)?$/.test(model)
  );
}
