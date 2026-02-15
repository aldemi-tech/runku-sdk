import { EventEmitter } from 'eventemitter3';

// Type alias for IDs (ObjectId as hex string)
export type ID = string;

export interface RunkuConfig {
  projectId: string;
  environmentId: string;
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
  wsUrl?: string;
  onTokenRefresh?: (tokens: AuthTokens) => void;
}

// Auth types
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface AppUser {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  provider?: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  status: 'active' | 'disabled' | 'pending';
  role?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface MFASetupResponse {
  secret: string;
  qrCodeUrl: string;
  backupCodes: string[];
}

export interface OAuthProvider {
  name: string;
  enabled: boolean;
  clientId?: string;
}

export interface LoginResponse {
  user?: AppUser;
  tokens?: AuthTokens;
  mfaRequired?: boolean;
  mfaToken?: string;
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
  action: {
    type: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    handler?: string;
    params?: Record<string, unknown>;
    functionName?: string;
    projectId?: string;
    environmentId?: string;
  };
  system: boolean;
  enabled: boolean;
  nextRun: string;
  lastRun?: string;
  lastStatus?: string;
  timeout: number;
  retries: number;
  priority: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
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
    headers?: Record<string, string>;
  };
  error?: string;
  attempt: number;
  workerNode: string;
}

export interface CreateCronOptions {
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  action: CronJob['action'];
  enabled?: boolean;
  timeout?: number;
  retries?: number;
  priority?: string;
}

class CronsClient {
  constructor(private client: RunkuClient) {}

  /**
   * List all crons for the current environment
   */
  async list(): Promise<CronJob[]> {
    // Cron-service returns a raw array
    return this.client.request<CronJob[]>('/crons');
  }

  /**
   * Get a specific cron by ID
   */
  async get(cronId: string): Promise<CronJob> {
    return this.client.request<CronJob>(`/crons/${cronId}`);
  }

  /**
   * Create a new cron job
   */
  async create(data: CreateCronOptions): Promise<CronJob> {
    return this.client.request<CronJob>('/crons', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Update a cron job
   */
  async update(cronId: string, data: Partial<CreateCronOptions>): Promise<CronJob> {
    return this.client.request<CronJob>(`/crons/${cronId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * Delete a cron job
   */
  async delete(cronId: string): Promise<void> {
    await this.client.request(`/crons/${cronId}`, { method: 'DELETE' });
  }

  /**
   * Trigger a cron job manually
   */
  async trigger(cronId: string): Promise<{ message: string; cronId: string }> {
    return this.client.request(`/crons/${cronId}/trigger`, { method: 'POST' });
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
    // Cron-service returns a raw array
    return this.client.request<CronExecution[]>(
      `/crons/${cronId}/executions${query ? `?${query}` : ''}`
    );
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

/**
 * Auth client for app user authentication
 * Provides methods for user registration, login, OAuth, MFA, and password management
 */
class AuthClient extends EventEmitter {
  private currentUser: AppUser | null = null;
  private refreshToken: string | null = null;

  constructor(private client: RunkuClient) {
    super();
  }

  /**
   * Get the current authenticated user
   */
  get user(): AppUser | null {
    return this.currentUser;
  }

  /**
   * Check if user is authenticated
   */
  get isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  /**
   * Register a new user with email and password
   */
  async register(email: string, password: string, name?: string): Promise<LoginResponse> {
    const response = await this.client.authRequest<LoginResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });

    if (response.user && response.tokens) {
      this.setSession(response.user, response.tokens);
    }

    return response;
  }

  /**
   * Login with email and password
   * May return mfaRequired: true if MFA is enabled
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await this.client.authRequest<LoginResponse>('/auth/login-mfa', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (response.user && response.tokens && !response.mfaRequired) {
      this.setSession(response.user, response.tokens);
    }

    return response;
  }

  /**
   * Complete MFA login after initial login returns mfaRequired
   */
  async verifyMFALogin(mfaToken: string, code: string): Promise<LoginResponse> {
    const response = await this.client.authRequest<LoginResponse>('/auth/mfa/login', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
    });

    if (response.user && response.tokens) {
      this.setSession(response.user, response.tokens);
    }

    return response;
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    try {
      await this.client.authRequest('/auth/logout', { method: 'POST' });
    } finally {
      this.clearSession();
    }
  }

  /**
   * Get OAuth authorization URL for social login
   */
  getOAuthUrl(provider: string, redirectUrl?: string): string {
    const params = new URLSearchParams();
    if (redirectUrl) {
      params.set('redirect_url', redirectUrl);
    }
    const query = params.toString();
    return `${this.client['config'].baseUrl}/api/v1/projects/${this.client['config'].projectId}/environments/${this.client['config'].environmentId}/auth/${provider}/authorize${query ? `?${query}` : ''}`;
  }

  /**
   * Exchange OAuth callback parameters for tokens
   * Usually called after redirect from OAuth provider
   */
  async handleOAuthCallback(code: string, state: string, provider: string): Promise<LoginResponse> {
    const response = await this.client.authRequest<LoginResponse>(
      `/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    );

    if (response.user && response.tokens) {
      this.setSession(response.user, response.tokens);
    }

    return response;
  }

  // ========== MFA Methods ==========

  /**
   * Setup MFA for the current user
   * Returns QR code URL and backup codes
   */
  async setupMFA(): Promise<MFASetupResponse> {
    return this.client.request<MFASetupResponse>('/auth/mfa/setup', { method: 'POST' });
  }

  /**
   * Verify and enable MFA with a code from authenticator app
   */
  async verifyMFA(code: string): Promise<{ enabled: boolean }> {
    const result = await this.client.request<{ enabled: boolean }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (result.enabled && this.currentUser) {
      this.currentUser.mfaEnabled = true;
      this.emit('user:updated', this.currentUser);
    }

    return result;
  }

  /**
   * Disable MFA for the current user
   */
  async disableMFA(code: string): Promise<void> {
    await this.client.request('/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (this.currentUser) {
      this.currentUser.mfaEnabled = false;
      this.emit('user:updated', this.currentUser);
    }
  }

  /**
   * Regenerate MFA backup codes
   */
  async regenerateBackupCodes(code: string): Promise<{ backupCodes: string[] }> {
    return this.client.request<{ backupCodes: string[] }>('/auth/mfa/backup-codes', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  // ========== Email Verification ==========

  /**
   * Send verification email to current user
   */
  async sendVerificationEmail(): Promise<void> {
    await this.client.request('/auth/verify-email/send', { method: 'POST' });
  }

  /**
   * Verify email with token from verification email
   */
  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    const result = await this.client.authRequest<{ verified: boolean }>(
      `/auth/verify-email?token=${encodeURIComponent(token)}`
    );

    if (result.verified && this.currentUser) {
      this.currentUser.emailVerified = true;
      this.emit('user:updated', this.currentUser);
    }

    return result;
  }

  // ========== Password Management ==========

  /**
   * Request password reset email
   * Always returns success to prevent email enumeration
   */
  async forgotPassword(email: string): Promise<void> {
    await this.client.authRequest('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Reset password with token from email
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.client.authRequest('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: newPassword }),
    });
  }

  /**
   * Change password for authenticated user
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.client.request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  // ========== Magic Link ==========

  /**
   * Send magic link login email
   * Always returns success to prevent email enumeration
   */
  async sendMagicLink(email: string): Promise<void> {
    await this.client.authRequest('/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Login with magic link token
   */
  async loginWithMagicLink(token: string): Promise<LoginResponse> {
    const response = await this.client.authRequest<LoginResponse>(
      `/auth/magic-link?token=${encodeURIComponent(token)}`
    );

    if (response.user && response.tokens) {
      this.setSession(response.user, response.tokens);
    }

    return response;
  }

  // ========== Profile Management ==========

  /**
   * Get current user profile
   */
  async getProfile(): Promise<AppUser> {
    const user = await this.client.request<AppUser>('/auth/me');
    this.currentUser = user;
    return user;
  }

  /**
   * Update current user profile
   */
  async updateProfile(data: { name?: string; avatar?: string; metadata?: Record<string, unknown> }): Promise<AppUser> {
    const user = await this.client.request<AppUser>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });

    this.currentUser = user;
    this.emit('user:updated', user);

    return user;
  }

  // ========== Session Management ==========

  /**
   * Refresh access token
   */
  async refreshTokens(): Promise<AuthTokens> {
    if (!this.refreshToken) {
      throw new RunkuError('No refresh token available', 'NO_REFRESH_TOKEN');
    }

    const response = await this.client.authRequest<{ tokens: AuthTokens }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });

    if (response.tokens) {
      this.client.setAccessToken(response.tokens.accessToken);
      this.refreshToken = response.tokens.refreshToken;
      this.emit('tokens:refreshed', response.tokens);

      if (this.client['config'].onTokenRefresh) {
        this.client['config'].onTokenRefresh(response.tokens);
      }
    }

    return response.tokens;
  }

  /**
   * Set session from stored tokens (for restoring session)
   */
  setTokens(tokens: AuthTokens): void {
    this.client.setAccessToken(tokens.accessToken);
    this.refreshToken = tokens.refreshToken;
  }

  /**
   * Initialize session by fetching current user
   * Call this after setting tokens to restore a session
   */
  async initSession(): Promise<AppUser | null> {
    try {
      const user = await this.getProfile();
      this.emit('session:restored', user);
      return user;
    } catch {
      this.clearSession();
      return null;
    }
  }

  private setSession(user: AppUser, tokens: AuthTokens): void {
    this.currentUser = user;
    this.client.setAccessToken(tokens.accessToken);
    this.refreshToken = tokens.refreshToken;
    this.emit('session:created', { user, tokens });
  }

  private clearSession(): void {
    this.currentUser = null;
    this.refreshToken = null;
    this.client.setAccessToken(null);
    this.emit('session:destroyed');
  }
}
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
  private config: Required<Omit<RunkuConfig, 'onTokenRefresh'>> & { onTokenRefresh?: (tokens: AuthTokens) => void };
  private accessToken: string | null = null;
  
  public db: DatabaseClient;
  public storage: StorageClient;
  public functions: FunctionsClient;
  public realtime: RealtimeClient;
  public crons: CronsClient;
  public auth: AuthClient;

  constructor(config: RunkuConfig) {
    this.config = {
      projectId: config.projectId,
      environmentId: config.environmentId,
      apiKey: config.apiKey || '',
      accessToken: config.accessToken || '',
      baseUrl: config.baseUrl || 'https://api.runku.io',
      wsUrl: config.wsUrl || 'wss://api.runku.io',
      onTokenRefresh: config.onTokenRefresh,
    };

    if (config.accessToken) {
      this.accessToken = config.accessToken;
    }

    this.db = new DatabaseClient(this);
    this.storage = new StorageClient(this);
    this.functions = new FunctionsClient(this);
    this.realtime = new RealtimeClient(this);
    this.crons = new CronsClient(this);
    this.auth = new AuthClient(this);
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  getWsUrl(): string {
    const params = new URLSearchParams();
    if (this.config.apiKey) {
      params.set('apiKey', this.config.apiKey);
    }
    if (this.accessToken) {
      params.set('token', this.accessToken);
    }
    const query = params.toString();
    return `${this.config.wsUrl}/ws/${this.config.projectId}${query ? `?${query}` : ''}`;
  }

  /**
   * Make authenticated request (uses access token if available)
   */
  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}/api/v1/projects/${this.config.projectId}/environments/${this.config.environmentId}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    // Prefer access token over API key for authenticated requests
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.config.apiKey) {
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

  /**
   * Make unauthenticated auth request (for login, register, etc.)
   */
  async authRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}/api/v1/projects/${this.config.projectId}/environments/${this.config.environmentId}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

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

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    } else if (this.config.apiKey) {
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

export { RunkuError, DatabaseClient, StorageClient, FunctionsClient, RealtimeClient, CronsClient, AuthClient };
export type { AuthTokens, AppUser, MFASetupResponse, OAuthProvider, LoginResponse };
export default RunkuClient;
