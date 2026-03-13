// Nova CLI visual design system

// Colours
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background
  bgGreen: "\x1b[42m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

export const LOGO = `
${c.cyan}${c.bold}  ╔╗╔╔═╗╦  ╦╔═╗${c.reset}
${c.cyan}${c.bold}  ║║║║ ║╚╗╔╝╠═╣${c.reset}   ${c.dim}Clone, deploy, and manage websites on Filecoin Onchain Cloud${c.reset}
${c.cyan}${c.bold}  ╝╚╝╚═╝ ╚╝ ╩ ╩${c.reset}
`;

export function banner() {
  console.log(LOGO);
}

export function step(num: number, total: number, text: string) {
  console.log(`  ${c.dim}[${num}/${total}]${c.reset} ${text}`);
}

export function info(text: string) {
  console.log(`  ${c.dim}${text}${c.reset}`);
}

export function success(text: string) {
  console.log(`  ${c.green}✔${c.reset} ${text}`);
}

export function fail(text: string) {
  console.log(`  ${c.red}✘${c.reset} ${text}`);
}

export function working(text: string) {
  console.log(`  ${c.yellow}⏳${c.reset} ${text}`);
}

export function label(key: string, value: string) {
  console.log(`  ${c.dim}${key.padEnd(6)}${c.reset} ${c.bold}${value}${c.reset}`);
}

export function labelDim(key: string, value: string) {
  console.log(`  ${c.dim}${key.padEnd(6)} ${value}${c.reset}`);
}

export function gutterLine(text: string) {
  console.log(`  ${c.dim}┃${c.reset}  ${text}`);
}

export function gutterTop(title?: string) {
  if (title) {
    console.log(`  ${c.dim}┏━━ ${c.reset}${c.cyan}${title}${c.reset}`);
  } else {
    console.log(`  ${c.dim}┏${c.reset}`);
  }
}

export function gutterBottom() {
  console.log(`  ${c.dim}┗━━${c.reset}`);
}

export function deployComplete(result: {
  cid: string;
  ensName?: string;
  txHash?: string;
  ethLimoUrl?: string;
}) {
  console.log("");
  console.log(`  ${c.green}${c.bold}━━━ Deploy complete ━━━${c.reset}`);
  console.log("");
  label("CID", result.cid);
  if (result.ensName) {
    label("ENS", result.ensName);
    labelDim("TX", result.txHash || "");
  }
  console.log("");
  if (result.ethLimoUrl) {
    console.log(`  ${c.bgGreen}${c.bold} ${result.ethLimoUrl} ${c.reset}`);
  } else {
    console.log(`  ${c.bold}  https://${result.cid}.ipfs.dweb.link${c.reset}`);
    info("No ENS configured — use an IPFS gateway to access your site.");
  }
  console.log("");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function promptLabel(text: string) {
  return `  ${c.cyan}?${c.reset} ${text} `;
}

/** Wrap a URL in an OSC 8 terminal hyperlink so the entire URL is clickable. */
export function link(url: string): string {
  if (!process.stderr.isTTY) return url;
  return `\x1b]8;;${url}\x1b\\${c.cyan}${url}${c.reset}\x1b]8;;\x1b\\`;
}

/** BigInt-safe JSON serializer (converts bigint to string to preserve precision) */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? val.toString() : val, 2);
}

/** Format a token amount with decimals, properly rounded to 4 decimal places. */
export function formatToken(val: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = val / divisor;
  const frac = val % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
  // Round: check the 5th digit
  const fifthDigit = decimals > 4 ? Number(frac.toString().padStart(decimals, "0")[4] || "0") : 0;
  if (fifthDigit >= 5) {
    const rounded = Number(fracStr) + 1;
    if (rounded >= 10000) {
      return `${whole + 1n}.0000`;
    }
    return `${whole}.${rounded.toString().padStart(4, "0")}`;
  }
  return `${whole}.${fracStr}`;
}

/** Check if a string looks like a URL (has protocol or domain.tld pattern). */
export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input);
}
