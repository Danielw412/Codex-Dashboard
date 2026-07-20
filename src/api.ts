import type { DashboardOverview } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function getOverview(): Promise<DashboardOverview> {
  return request('/api/overview');
}

export function refreshOverview(): Promise<DashboardOverview> {
  return request('/api/refresh', { method: 'POST' });
}
