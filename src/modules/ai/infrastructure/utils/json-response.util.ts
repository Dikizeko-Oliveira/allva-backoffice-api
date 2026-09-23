export function parseJsonResponse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);

    if (fenced?.[1]) {
      return JSON.parse(fenced[1]) as T;
    }

    const objectLike = raw.match(/\{[\s\S]*\}/);

    if (objectLike?.[0]) {
      return JSON.parse(objectLike[0]) as T;
    }

    throw new Error('Invalid JSON response from AI provider');
  }
}
