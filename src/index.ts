import { EventEmitter } from 'eventemitter3';

// Type alias for IDs (ObjectId as hex string)
export type ID = string;

export interface RunkuConfig {
  projectId: string;
  apiKey?: string;
  baseUrl?: string;
  wsUrl?: string;
}

// Pagination metadata (only-with-pagination principle)
export interface Meta {
  cursor?: string;
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
  limit: number;
  total?: number;
}

// Paginated response structure
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: Meta;
}

// Single item response structure
export interface SingleResponse<T> {
  success: boolean;
  data: T;
}

export interface QueryOptions {
  limit?: number;
  cursor?: string;
  sort?: Record<string, 1 | -1>;
  projection?: Record<string, 0 | 1>;
}

export interface Document {
  id: ID;
  [key: string]: any;
}

export interface InsertResult {
  id: ID;
}

export interface UpdateResult {
  id: ID;
  modified: boolean;
}

export interface DeleteResult {
  deleted: boolean;
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

// Cursor-based iterator for paginated results
export class CursorIterator<T> implements AsyncIterable<T> {
  private currentBatch: T[] = [];
  private batchIndex = 0;
  private cursor: string | undefined;
  private _hasMore = true;
  private batchSizeValue: number;

  constructor(
    private fetchBatch: (cursor?: string, limit?: number) => Promise<PaginatedResponse<T>>,
    batchSize: number = 20
  ) {
    this.batchSizeValue = batchSize;
  }

  hasMore(): boolean {
    return this._hasMore || this.batchIndex < this.currentBatch.length;
  }

  async nextBatch(): Promise<T[]> {
    if (!this._hasMore && this.currentBatch.length === 0) {
      return [];
    }

    const response = await this.fetchBatch(this.cursor, this.batchSizeValue);
    this.currentBatch = response.data;
    this.batchIndex = 0;
    this._hasMore = response.meta.hasMore;
    this.cursor = response.meta.nextCursor;

    return this.currentBatch;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (this.hasMore()) {
      if (this.batchIndex >= this.currentBatch.length) {
        if (!this._hasMore && this.currentBatch.length > 0) {
          return;
        }
        await this.nextBatch();
        if (this.currentBatch.length === 0) {
          return;
        }
      }
      yield this.currentBatch[this.batchIndex++];
    }
  }

  batchSize(size: number): CursorIterator<T> {
    this.batchSizeValue = size;
    return this;
  }
}

// Query builder for fluent API
export class QueryBuilder<T extends Document = Document> {
  private _filter: Record<string, any> = {};
  private _sort?: Record<string, 1 | -1>;
  private _limit?: number;
  private _cursor?: string;
  private _projection?: Record<string, 0 | 1>;

  constructor(
    private collection: string,
    private client: DatabaseClient
  ) {}

  filter(filter: Record<string, any>): QueryBuilder<T> {
    this._filter = { ...this._filter, ...filter };
    return this;
  }

  sort(sort: Record<string, 1 | -1>): QueryBuilder<T> {
    this._sort = sort;
    return this;
  }

  limit(limit: number): QueryBuilder<T> {
    this._limit = limit;
    return this;
  }

  cursor(cursor: string): QueryBuilder<T> {
    this._cursor = cursor;
    return this;
  }

  project(projection: Record<string, 0 | 1>): QueryBuilder<T> {
    this._projection = projection;
    return this;
  }

  // Execute query and return paginated result
  async exec(): Promise<PaginatedResponse<T>> {
    return this.client.queryRaw<T>(this.collection, this._filter, {
      sort: this._sort,
      limit: this._limit,
      cursor: this._cursor,
      projection: this._projection,
    });
  }

  // Get iterator for batch processing
  iterator(): CursorIterator<T> {
    return new CursorIterator<T>(
      (cursor, limit) => this.client.queryRaw<T>(this.collection, this._filter, {
        sort: this._sort,
        limit: limit || this._limit,
        cursor,
        projection: this._projection,
      }),
      this._limit || 20
    );
  }

  // Load all results up to a maximum (with safety limit)
  async toArray(options?: { maxItems?: number }): Promise<T[]> {
    const maxItems = options?.maxItems || 10000;
    const results: T[] = [];
    const iterator = this.iterator();

    for await (const item of iterator) {
      results.push(item);
      if (results.length >= maxItems) {
        break;
      }
    }

    return results;
  }
}

class DatabaseClient {
  constructor(private client: RunkuClient) {}

  // Create a query builder for fluent API
  collection<T extends Document = Document>(name: string): QueryBuilder<T> {
    return new QueryBuilder<T>(name, this);
  }

  // Raw query with pagination (internal use)
  async queryRaw<T extends Document = Document>(
    collection: string,
    filter: Record<string, any> = {},
    options: QueryOptions = {}
  ): Promise<PaginatedResponse<T>> {
    const params = new URLSearchParams();
    if (Object.keys(filter).length > 0) {
      params.set('filter', JSON.stringify(filter));
    }
    if (options.sort) {
      params.set('sort', JSON.stringify(options.sort));
    }
    if (options.limit) {
      params.set('limit', String(options.limit));
    }
    if (options.cursor) {
      params.set('cursor', options.cursor);
    }
    
    const query = params.toString();
    return this.client.request<PaginatedResponse<T>>(
      `/data/${collection}${query ? `?${query}` : ''}`
    );
  }

  // Convenience method for simple queries
  async query<T extends Document = Document>(
    collection: string,
    filter: Record<string, any> = {},
    options: QueryOptions = {}
  ): Promise<T[]> {
    const response = await this.queryRaw<T>(collection, filter, options);
    return response.data;
  }

  async findOne<T extends Document = Document>(
    collection: string,
    filter: Record<string, any>
  ): Promise<T | null> {
    const response = await this.queryRaw<T>(collection, filter, { limit: 1 });
    return response.data[0] || null;
  }

  async findById<T extends Document = Document>(
    collection: string,
    id: ID
  ): Promise<T | null> {
    try {
      const response = await this.client.request<SingleResponse<T>>(`/data/${collection}/${id}`);
      return response.data;
    } catch (err) {
      if (err instanceof RunkuError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async insert<T extends Document = Document>(
    collection: string,
    document: Omit<T, 'id'>
  ): Promise<InsertResult> {
    const response = await this.client.request<SingleResponse<InsertResult>>(`/data/${collection}`, {
      method: 'POST',
      body: JSON.stringify(document),
    });
    return response.data;
  }

  async insertMany<T extends Document = Document>(
    collection: string,
    documents: Omit<T, 'id'>[]
  ): Promise<{ ids: ID[] }> {
    const response = await this.client.request<SingleResponse<{ ids: ID[] }>>(`/data/${collection}/bulk`, {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
    return response.data;
  }

  async update(
    collection: string,
    id: ID,
    update: Record<string, any>
  ): Promise<UpdateResult> {
    const response = await this.client.request<SingleResponse<UpdateResult>>(`/data/${collection}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(update),
    });
    return response.data;
  }

  async delete(collection: string, id: ID): Promise<DeleteResult> {
    const response = await this.client.request<SingleResponse<DeleteResult>>(`/data/${collection}/${id}`, {
      method: 'DELETE',
    });
    return response.data;
  }

  async count(collection: string, filter: Record<string, any> = {}): Promise<number> {
    const params = new URLSearchParams();
    if (Object.keys(filter).length > 0) {
      params.set('filter', JSON.stringify(filter));
    }
    const query = params.toString();
    const response = await this.client.request<SingleResponse<{ count: number }>>(
      `/data/${collection}/count${query ? `?${query}` : ''}`
    );
    return response.data.count;
  }

  async aggregate<T = any>(collection: string, pipeline: Record<string, any>[]): Promise<T[]> {
    const response = await this.client.request<PaginatedResponse<T>>(`/data/${collection}/aggregate`, {
      method: 'POST',
      body: JSON.stringify({ pipeline }),
    });
    return response.data;
  }
}

// Cron types
export interface CronJob {
  id: string;
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  enabled: boolean;
  nextRun: string;
  lastRun?: string;
  lastStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronExecution {
  id: string;
  cronId: string;
  cronName: string;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  duration?: number;
  response?: {
    statusCode?: number;
    body?: string;
  };
  error?: string;
}

class CronsClient {
  constructor(private client: RunkuClient) {}

  /**
   * List all crons for the current environment
   */
  async list(): Promise<CronJob[]> {
    const response = await this.client.request<{ crons: CronJob[]; total: number }>('/crons');
    return response.crons;
  }

  /**
   * Get a specific cron by ID
   */
  async get(cronId: string): Promise<CronJob> {
    return this.client.request<CronJob>(`/crons/${cronId}`);
  }

  /**
   * Get execution history for a cron
   */
  async executions(cronId: string, limit?: number): Promise<CronExecution[]> {
    const params = new URLSearchParams();
    if (limit) {
      params.set('limit', String(limit));
    }
    const query = params.toString();
    const response = await this.client.request<{ executions: CronExecution[]; total: number }>(
      `/crons/${cronId}/executions${query ? `?${query}` : ''}`
    );
    return response.executions;
  }
}

class StorageClient {
  constructor(private client: RunkuClient) {}

  async list(prefix?: string, cursor?: string, limit?: number): Promise<PaginatedResponse<StorageFile>> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return this.client.request(`/storage${query ? `?${query}` : ''}`);
  }

  // Get iterator for listing files with pagination
  listIterator(prefix?: string, batchSize: number = 20): CursorIterator<StorageFile> {
    return new CursorIterator<StorageFile>(
      (cursor, limit) => this.list(prefix, cursor, limit || batchSize),
      batchSize
    );
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
  public crons: CronsClient;

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
    this.crons = new CronsClient(this);
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

export { RunkuError, DatabaseClient, StorageClient, FunctionsClient, RealtimeClient, CronsClient };
export default RunkuClient;
