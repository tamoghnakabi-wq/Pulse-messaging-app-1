import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { Attachment } from '@/shared/types';

export const uploadService = {
  async uploadFiles(
    files: File[],
    conversationId?: string,
    onProgress?: (pct: number) => void
  ): Promise<Attachment[]> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    if (conversationId) form.append('conversationId', conversationId);
    const res = await api.post('/uploads', form, {
      onUploadProgress: (e) => {
        if (e.total && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return extractData<{ attachments: Attachment[] }>(res).attachments;
  },
};
