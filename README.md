# @runku/sdk

Official JavaScript/TypeScript SDK for Runku BaaS.

## Installation

```bash
npm install @runku/sdk
# or
pnpm add @runku/sdk
# or
yarn add @runku/sdk
```

## Quick Start

```typescript
import { createClient } from '@runku/sdk';

const runku = createClient({
  projectId: 'your-project-id',
  apiKey: 'your-api-key',
});

// Query data
const users = await runku.db.query('users', { active: true });

// Insert data
const result = await runku.db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
});

// Execute a serverless function
const response = await runku.functions.call('sendEmail', {
  to: 'user@example.com',
  subject: 'Hello!',
});
```

## Database Operations

### Query Documents

```typescript
// Simple query
const users = await runku.db.query('users');

// With filter
const activeUsers = await runku.db.query('users', { active: true });

// With options
const pagedUsers = await runku.db.query('users', { active: true }, {
  limit: 10,
  skip: 20,
  sort: { createdAt: -1 },
  projection: { password: 0 },
});

// Find one document
const user = await runku.db.findOne('users', { email: 'john@example.com' });

// Find by ID
const user = await runku.db.findById('users', 'user-id');
```

### Insert Documents

```typescript
// Insert one
const result = await runku.db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
});
console.log(result.insertedId);

// Insert many
const result = await runku.db.insertMany('users', [
  { name: 'John', email: 'john@example.com' },
  { name: 'Jane', email: 'jane@example.com' },
]);
console.log(result.insertedIds);
```

### Update Documents

```typescript
// Update by filter
const result = await runku.db.update('users', 
  { email: 'john@example.com' },
  { $set: { active: true } }
);

// Update by ID
const result = await runku.db.updateById('users', 'user-id', {
  $set: { name: 'John Smith' },
});
```

### Delete Documents

```typescript
// Delete by filter
const result = await runku.db.delete('users', { active: false });

// Delete by ID
const result = await runku.db.deleteById('users', 'user-id');
```

### Aggregation

```typescript
const stats = await runku.db.aggregate('orders', [
  { $match: { status: 'completed' } },
  { $group: { _id: '$userId', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $limit: 10 },
]);
```

## Storage Operations

### Upload Files

```typescript
// Upload a file
const file = await runku.storage.upload('images/logo.png', blob, {
  contentType: 'image/png',
  metadata: { uploadedBy: 'user-123' },
});

// Upload text content
const file = await runku.storage.upload('config.json', JSON.stringify(config), {
  contentType: 'application/json',
});
```

### Download Files

```typescript
const blob = await runku.storage.download('images/logo.png');
```

### List Files

```typescript
const { files, cursor } = await runku.storage.list('images/');

// Paginate
const { files: moreFiles } = await runku.storage.list('images/', cursor);
```

### Delete Files

```typescript
await runku.storage.delete('images/old-logo.png');
```

### Signed URLs

```typescript
// Get a signed URL valid for 1 hour
const url = await runku.storage.getSignedUrl('images/logo.png', 3600);
```

## Serverless Functions

### Execute Functions

```typescript
// Simple execution
const result = await runku.functions.call('processOrder', {
  orderId: 'order-123',
});

// With full response (includes logs and timing)
const { result, logs, executionTime } = await runku.functions.execute('processOrder', {
  orderId: 'order-123',
});
```

## Real-time Subscriptions

### Subscribe to Collection Changes

```typescript
// Connect to real-time
runku.realtime.connect();

// Subscribe to a collection
runku.realtime.subscribe('messages');

// Listen for changes
runku.realtime.on('insert', (event) => {
  console.log('New document:', event.document);
});

runku.realtime.on('update', (event) => {
  console.log('Updated document:', event.document);
});

runku.realtime.on('delete', (event) => {
  console.log('Deleted document ID:', event.documentId);
});

// Subscribe to specific collection events
runku.realtime.on('messages:insert', (event) => {
  console.log('New message:', event.document);
});

// Unsubscribe
runku.realtime.unsubscribe('messages');

// Disconnect
runku.realtime.disconnect();
```

### Connection Events

```typescript
runku.realtime.on('connected', () => {
  console.log('Connected to real-time server');
});

runku.realtime.on('disconnected', () => {
  console.log('Disconnected from real-time server');
});

runku.realtime.on('error', (error) => {
  console.error('Real-time error:', error);
});
```

## Error Handling

```typescript
import { RunkuError } from '@runku/sdk';

try {
  await runku.db.insert('users', { email: 'john@example.com' });
} catch (error) {
  if (error instanceof RunkuError) {
    console.error('Runku error:', error.message);
    console.error('Error code:', error.code);
    console.error('HTTP status:', error.status);
  }
}
```

## TypeScript Support

The SDK is fully typed. You can define your document types:

```typescript
interface User {
  _id: string;
  name: string;
  email: string;
  active: boolean;
}

const users = await runku.db.query<User>('users', { active: true });
// users is typed as User[]

const user = await runku.db.findById<User>('users', 'user-id');
// user is typed as User | null
```

## Configuration

```typescript
const runku = createClient({
  projectId: 'your-project-id',  // Required
  apiKey: 'your-api-key',        // Required for client-side usage
  baseUrl: 'https://api.runku.io', // Optional, defaults to Runku cloud
  wsUrl: 'wss://api.runku.io',     // Optional, for real-time connections
});
```

## License

MIT
