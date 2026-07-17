import type { AxiosResponse } from 'axios';
import type { ApiSuccessResponse } from './types';

/** Pull typed `data` from a successful API envelope response. */
export function extractData<T>(response: AxiosResponse<ApiSuccessResponse<T>>): T {
  return response.data.data;
}
