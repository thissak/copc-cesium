# Codex → Claude Code SSOT Bridge

이 파일은 Codex 호환용 얇은 브릿지입니다. 프로젝트 규칙을 이중으로 관리하지
않으며, Claude Code 문서를 SSOT로 사용합니다.

세션 시작 시 다음 순서로 각 파일을 **끝까지 읽고** 적용합니다.

1. 글로벌 규칙: `~/.claude/CLAUDE.md`
2. 프로젝트 규칙: `./CLAUDE.md`
3. 프로젝트 상태: `./docs/PROGRESS.md`
4. 변경 이력: `./docs/CHANGELOG.md`

규칙이 충돌하면 더 구체적인 프로젝트 규칙을 우선합니다. 이 파일에
`CLAUDE.md`의 내용을 복제하지 말고, 규칙은 항상 Claude Code SSOT에서만 수정합니다.

글로벌 스킬 SSOT는 `~/.claude/skills/`입니다.
`~/.agents/skills/`의 동일 이름 항목은 Codex 발견용 포인터로만
취급하고, 규칙이나 스킬 본문을 복제하지 않습니다.
