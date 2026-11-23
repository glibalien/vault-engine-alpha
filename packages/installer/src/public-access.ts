import { join } from 'node:path';
import type { InstallState } from './state.js';
import { shellCommand } from './text.js';
import { plannedManager, restartCommand } from './service-manager.js';
import { CURATOR_UNIT, ENGINE_UNIT } from './units.js';

/**
 * The command that mints (or, with `revoke`, revokes) an Engine service token named
 * `name` with Engine's own script, filled in for this installation. The token is printed
 * once, by the script.
 */
export function engineTokenCommand(plan: Pick<InstallState['plan'], 'repo_root' | 'vault' | 'review' | 'services'>, name: string, revoke = false): string {
  return [
    `cd ${shellCommand([plan.repo_root])} &&`,
    `VAULT_PATH=${shellCommand([plan.vault?.path ?? '<vault>'])}`,
    `DB_PATH=${shellCommand([plan.review.engine_database ?? '<database>'])}`,
    `${shellCommand([plan.services.node_path])} --import tsx packages/engine/scripts/issue-service-token.ts --name ${name}${revoke ? ' --revoke' : ''}`,
  ].join(' ');
}

/** The command that revokes every Curator service token named `name`, with Curator's own script. */
export function curatorRevokeCommand(plan: Pick<InstallState['plan'], 'repo_root' | 'data_dir' | 'services'>, name: string): string {
  return [
    `cd ${shellCommand([plan.repo_root])} &&`,
    `CURATOR_DB_PATH=${shellCommand([join(plan.data_dir, 'curator.db')])}`,
    `${shellCommand([plan.services.node_path])} --import tsx packages/curator/scripts/issue-service-token.ts --name ${name} --revoke`,
  ].join(' ');
}

/**
 * `PUBLIC-ACCESS.md`: how to reach the services from the internet, filled in with this
 * installation's ports and files. The installer writes it and does none of it: no
 * tunnel, DNS, open port, or certificate.
 */
export function publicAccessGuide(plan: InstallState['plan'], generatedAt: Date): string {
  const enginePort = plan.services.engine_port;
  const curatorPort = plan.services.curator_port;
  const curator = plan.curator !== null;
  const engineEnv = join(plan.data_dir, 'engine.env');
  const curatorEnv = join(plan.data_dir, 'curator.env');
  const manager = plannedManager(plan.services);
  const restart = restartCommand(manager, curator ? [ENGINE_UNIT, CURATOR_UNIT] : [ENGINE_UNIT]);
  // The Mac app's command line needs no sudo; Linux's tailscaled does.
  const tailscale = manager === 'launchd' ? 'tailscale' : 'sudo tailscale';
  const tokenCommand = (name: string, revoke = false) => engineTokenCommand(plan, name, revoke);
  const hosts = curator ? 'engine.example.com and curator.example.com' : 'engine.example.com';

  return `# Reaching Vault Suite from the internet

Written by vault-installer on ${generatedAt.toISOString().slice(0, 10)} for this machine. **Nothing here has been
done for you.** The installer never installs a tunnel, changes DNS, opens a port, or
obtains a certificate.

Engine listens on 127.0.0.1:${enginePort}${curator ? ` and Curator on 127.0.0.1:${curatorPort}` : ''}, so only this machine
can reach ${curator ? 'them' : 'it'}. Replace ${hosts} below with your own
hostnames.

## 1. Do you need it?

- **No** for Obsidian on this machine: the Vault Engine plugin talks to
  http://localhost:${enginePort}.
- **Yes** for Claude.ai or ChatGPT connectors, phones, and other machines.

## 2. The options

| Option | Needs | Public URL | Notes |
| --- | --- | --- | --- |
| Cloudflare Tunnel | A domain on Cloudflare | https://engine.example.com | No inbound ports; the reference deployment |
| Tailscale Funnel | A Tailscale account | https://<machine>.<tailnet>.ts.net | No domain needed; Funnel serves ports 443, 8443, and 10000 |
| Caddy (or nginx) with Let's Encrypt | A public IP, ports 80 and 443, DNS names | https://engine.example.com | Certificates renew automatically |
| Tailscale, private only | Tailscale on every client | None | Claude.ai cannot reach it |

Give each service its own hostname (or port), and put exactly one proxy in front of it.

## 3. Steps

### Cloudflare Tunnel

1. Install \`cloudflared\`, then run \`cloudflared tunnel login\` and
   \`cloudflared tunnel create vault-suite\`.
2. In the tunnel's configuration (\`~/.cloudflared/config.yml\`):

   \`\`\`yaml
   tunnel: <tunnel id>
   credentials-file: <path to the tunnel's credentials .json>
   ingress:
     - hostname: engine.example.com
       service: http://127.0.0.1:${enginePort}
${curator ? `     - hostname: curator.example.com
       service: http://127.0.0.1:${curatorPort}
` : ''}     - service: http_status:404
   \`\`\`

3. Point the hostname${curator ? 's' : ''} at the tunnel: \`cloudflared tunnel route dns vault-suite engine.example.com\`${curator ? `
   and the same for curator.example.com` : ''}. Then run the tunnel as a service, as Cloudflare's
   documentation describes.

### Tailscale Funnel

\`\`\`bash
${tailscale} funnel --bg --https=443 http://127.0.0.1:${enginePort}
${curator ? `${tailscale} funnel --bg --https=8443 http://127.0.0.1:${curatorPort}
` : ''}\`\`\`

Engine is then at https://<machine>.<tailnet>.ts.net${curator ? `, and Curator at https://<machine>.<tailnet>.ts.net:8443` : ''}.
The flags differ between Tailscale versions; check \`tailscale funnel --help\`.

### Caddy

\`\`\`
engine.example.com {
	reverse_proxy 127.0.0.1:${enginePort}
}
${curator ? `curator.example.com {
	reverse_proxy 127.0.0.1:${curatorPort}
}
` : ''}\`\`\`

### Then, whichever option you chose

1. Set \`OAUTH_ISSUER_URL\` to the public HTTPS address: in \`${engineEnv}\` to
   https://engine.example.com${curator ? `, and in \`${curatorEnv}\` to https://curator.example.com.
   Curator's \`ENGINE_URL\` stays http://127.0.0.1:${enginePort}` : ''}.
2. Restart: \`${restart}\`.
3. Check from another machine:

   \`\`\`bash
   curl -s https://engine.example.com/.well-known/oauth-authorization-server | head -c 300
   curl -s -o /dev/null -w '%{http_code}\\n' https://engine.example.com/mcp   # 200
   \`\`\`

## 4. Connecting clients

- **Claude.ai:** add a custom connector at https://engine.example.com/mcp${curator ? ` (and
  https://curator.example.com/mcp for Curator)` : ''}, and sign in with the owner password,
  \`OAUTH_OWNER_PASSWORD\` in \`${engineEnv}\`${curator ? ` (Curator's is in \`${curatorEnv}\`)` : ''}.
- **The Obsidian plugin:** give it a service token, minted with Engine's own script (it is
  shown once):

  \`\`\`bash
  ${tokenCommand('obsidian')}
  \`\`\`

## 5. Security checklist

- Keep the services on 127.0.0.1, as they are. Never forward ports ${enginePort}${curator ? ` or ${curatorPort}` : ''} directly.
- Put exactly one proxy hop in front of each: the services trust one (\`trust proxy\` is
  1) for rate limiting and the addresses they log.
- Use OAuth for shared connectors; never put a static service token in one.
- To change an owner password, edit \`OAUTH_OWNER_PASSWORD\` and restart the service.
  To revoke a service token, for example the Obsidian plugin's:

  \`\`\`bash
  ${tokenCommand('obsidian', true)}
  \`\`\`
- Back up \`${plan.data_dir}\` (its env files${curator ? " and Curator's database" : ''}) and Engine's database,
  \`${plan.review.engine_database ?? '<database>'}\`.
`;
}
