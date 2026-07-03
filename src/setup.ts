import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

export function runSetup(): void {
  const skillDir = resolve(homedir(), ".config", "opencode", "skills", "slack-agent");
  mkdirSync(skillDir, { recursive: true });

  const skillSrc = resolve(projectRoot, ".opencode", "skill", "slack-loop", "SKILL.md");
  const skillDest = resolve(skillDir, "SKILL.md");

  if (existsSync(skillSrc)) {
    copyFileSync(skillSrc, skillDest);
    console.log(`✅ SKILL.md → ${skillDest}`);
  } else {
    console.error(`❌ SKILL.md not found at ${skillSrc}`);
    process.exit(1);
  }

  const mcpDest = resolve(skillDir, "mcp.json");
  const mcpConfig = {
    mcpServers: {
      "slack-agent": {
        command: "npx",
        args: ["-y", "github:leecoder/opencode-slack-agent"],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "xoxb-YOUR-BOT-TOKEN",
          SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN || "xapp-YOUR-APP-TOKEN",
        },
      },
    },
  };
  writeFileSync(mcpDest, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log(`✅ mcp.json → ${mcpDest}`);

  if (mcpConfig.mcpServers["slack-agent"].env.SLACK_BOT_TOKEN.startsWith("xoxb-YOUR")) {
    console.log(`\n⚠️  mcp.json의 SLACK_BOT_TOKEN과 SLACK_APP_TOKEN을 실제 값으로 교체하세요:`);
    console.log(`   ${mcpDest}`);
  }

  console.log(`\n🎉 설치 완료! 이제 opencode에서 /slack-loop 커맨드를 사용할 수 있습니다.`);
}
