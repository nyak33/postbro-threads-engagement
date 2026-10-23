import { buildApp } from './app';
import { parseConfig } from './config';

async function main(): Promise<void> {
  const config = parseConfig();
  const app = buildApp({ logger: true });

  try {
    await app.listen({ host: '0.0.0.0', port: config.port });
  } catch (error) {
    app.log.error(error);
    await app.close();
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
