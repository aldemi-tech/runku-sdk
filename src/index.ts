import { EventEmitter } from 'eventemitter3';

export interface RunkuConfig {
  projectId: string;
  apiKey?: string;
  baseUrl?: string;
  wsUrl?: string;
}

export interface QueryOptions {
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
  projection?: Record<string, 0 | 1>;
}

export interface Document {
  _id: string;
  [key: string]: any;
}

export interface InsertResult {
  insertedId: string;
}

export interface UpdateResult {
  matchedCount: number;
  modifiedCount: number;
}

export interface DeleteResult {
  deletedCount: number;
}

export interface ExecuteResult<T = any> {
  result: T;
  logs: string[];
  executionTime: number;
}

export interface StorageFile {
  key: string;
  size: number;
  contentType: string;
  lastModified: string;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

type RealtimeEventType = 'insert' | 'update' | 'delete' | 'error';

interface RealtimeEvent {
  type: RealtimeEventType;
  collection: string;
  document?: Document;
  documentId?: string;
  error?: string;
}

class RunkuError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number
  ) {
    super(message);
    this.name = 'RunkuError';
  }
}

class DatabaseClient {
  constructor(private client: RunkuClient) {}

  async query<T extends Document = Document>(
    collection: string,
    filter: Record<string, any> = {},
    options: QueryOptions = {}
  ): Promise<T[]> {
    const response = await this.client.request<{ documents: T[] }>(
      `/data/${collection}/query`,
      {
        method: 'POST',
        body: JSON.stringify({ filter, ...options }),
      }
    );
    return response.documents;
  }

  async findOne<T extends Document = Document>(
    collection: string,
    filter: Record<string, any>
  ): Promise<T | null> {
    const docs = await this.query<T>(collection, filter, { limit: 1 });
    return docs[0] || null;
  }

  async findById<T extends Document = Document>(
    collection: string,
    id: string
  ): Promise<T | null> {
    return this.findOne<T>(collection, { _id: id });
  }

  async insert<T extends Document = Document>(
    collection: string,
    document: Omit<T, '_id'>
  ): Promise<InsertResult> {
    return this.client.request<InsertResult>(`/data/${collection}`, {
      method: 'POST',
      body: JSON.stringify(document),
    });
  }

  async insertMany<T extends Document = Document>(
    collection: string,
    documents: Omit<T, '_id'>[]
  ): Promise<{ insertedIds: string[] }> {
    return this.client.request<{ insertedIds: string[] }>(`/data/${collection}/bulk`, {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
  }

  async update(
    collection: string,
    filter: Record<string, any>,
    update: Record<string, any>
  ): Promise<UpdateResult> {
    return this.client.request<UpdateResult>(`/data/${collection}/update`, {
      method: 'POST',
      body: JSON.stringify({ filter, update }),
    });
  }

  async updateById(
    collection: string,
    id: string,
    update: Record<string, any>
  ): Promise<UpdateResult> {
    return this.update(collection, { _id: id }, update);
  }

  async delete(collection: string, filter: Record<string, any>): Promise<DeleteResult> {
    return this.client.request<DeleteResult>(`/data/${collection}/delete`, {
      method: 'POST',
      body: JSON.stringify({ filter }),
    });
  }

  async deleteById(collection: string, id: string): Promise<DeleteResult> {
    return this.delete(collection, { _id: id });
  }

  async count(collection: string, filter: Record<string, any> = {}): Promise<number> {
    const response = await this.client.request<{ count: number }>(`/data/${collection}/count`, {
      method: 'POST',
      body: JSON.stringify({ filter }),
    });
    return response.count;
  }

  async aggregate<T = any>(collection: string, pipeline: Record<string, any>[]): Promise<T[]> {
    const response = await this.client.request<{ results: T[] }>(`/data/${collection}/aggregate`, {
      method: 'POST',
      body: JSON.stringify({ pipeline }),
    });
    return response.results;
  }
}

class StorageClient {
  constructor(private client: RunkuClient) {}

  async list(prefix?: string, cursor?: string): Promise<{ files: StorageFile[]; cursor?: string }> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return this.client.request(`/storage${query ? `?${query}` : ''}`);
  }

  async upload(key: string, data: Blob | ArrayBuffer | string, options?: UploadOptions): Promise<StorageFile> {
    const formData = new FormData();
    
    if (typeof data === 'string') {
      formData.append('file', new Blob([data], { type: options?.contentType || 'text/plain' }), key);
    } else if (data instanceof ArrayBuffer) {
      formData.append('file', new Blob([data], { type: options?.contentType }), key);
    } else {
      formData.append('file', data, key);
    }

    if (options?.metadata) {
      formData.append('metadata', JSON.stringify(options.metadata));
    }

    return this.client.request<StorageFile>('/storage/upload', {
      method: 'POST',
      body: formData,
      headers: {},
    });
  }

  async download(key: string): Promise<Blob> {
    const response = await this.client.rawRequest(`/storage/${encodeURIComponent(key)}`);
    return response.blob();
  }

  async delete(key: string): Promise<void> {
    await this.client.request(`/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const response = await this.client.request<{ url: string }>(
      `/storage/${encodeURIComponent(key)}/signed-url?expiresIn=${expiresIn}`
    );
    return response.url;
  }
}

class FunctionsClient {
  constructor(private client: RunkuClient) {}

  async execute<T = any>(functionName: string, args?: Record<string, any>): Promise<ExecuteResult<T>> {
    return this.client.request<ExecuteResult<T>>(`/execute/${functionName}`, {
      method: 'POST',
      body: JSON.stringify({ args }),
    });
  }

  async call<T = any>(functionName: string, args?: Record<string, any>): Promise<T> {
    const result = await this.execute<T>(functionName, args);
    return result.result;
  }
}

class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(private client: RunkuClient) {
    super();
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.client.getWsUrl();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit('connected');
      
      // Resubscribe to all collections
      this.subscriptions.forEach(collection => {
        this.send({ type: 'subscribe', collection });
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RealtimeEvent;
        this.emit(data.type, data);
        this.emit(`${data.collection}:${data.type}`, data);
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.emit('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.emit('error', new Error('WebSocket error'));
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  subscribe(collection: string, filter?: Record<string, any>): void {
    this.subscriptions.add(collection);
    this.send({ type: 'subscribe', collection, filter });
  }

  unsubscribe(collection: string): void {
    this.subscriptions.delete(collection);
    this.send({ type: 'unsubscribe', collection });
  }

  disconnect(): void {
    this.subscriptions.clear();
    this.ws?.close();
    this.ws = null;
  }
}

export class RunkuClient {
  private config: Required<RunkuConfig>;
  
  public db: DatabaseClient;
  public storage: StorageClient;
  public functions: FunctionsClient;
  public realtime: RealtimeClient;

  constructor(config: RunkuConfig) {
    this.config = {
      projectId: config.projectId,
      apiKey: config.apiKey || '',
      baseUrl: config.baseUrl || 'https://api.runku.io',
      wsUrl: config.wsUrl || 'wss://api.runku.io',
    };

    this.db = new DatabaseClient(this);
    this.storage = new StorageClient(this);
    this.functions = new FunctionsClient(this);
    this.realtime = new RealtimeClient(this);
  }

  getWsUrl(): string {
    return `${this.config.wsUrl}/ws/${this.config.projectId}?apiKey=${this.config.apiKey}`;
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}/api/v1/projects/${this.config.projectId}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new RunkuError(error.error || error.message, error.code || 'UNKNOWN', response.status);
    }

    if (response.status === 204) {
      return null as T;
    }

    return response.json();
  }

  async rawRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.baseUrl}/api/v1/projects/${this.config.projectId}${endpoint}`;
    
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new RunkuError('Request failed', 'REQUEST_FAILED', response.status);
    }

    return response;
  }
}

export function createClient(config: RunkuConfig): RunkuClient {
  return new RunkuClient(config);
}

export { RunkuError };
export default RunkuClient;
