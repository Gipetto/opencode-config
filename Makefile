.PHONY: init install check update personal-skills

init: check install        # first run: verify, pre-warm, link
	nix build .#everything

install:
	./install.sh

check:
	nix flake check

update:                    # after any flake/pin change: bump inputs, pre-warm
	nix flake update
	nix build .#everything

personal-skills:           # link private skill dirs listed in personal-skills.local
	@test -f personal-skills.local || { echo "personal-skills.local not found: list one absolute skill directory per line"; exit 1; }
	@grep -v '^[[:space:]]*\(#\|$$\)' personal-skills.local | while read -r src; do \
	  src="$${src/#\~/$$HOME}"; name="$$(basename "$$src")"; dest="skills/$$name"; \
	  if [ ! -f "$$src/SKILL.md" ]; then echo "skip $$src: no SKILL.md"; continue; fi; \
	  if [ -e "$$dest" ] && [ ! -L "$$dest" ]; then echo "skip $$dest: exists and is not a link"; continue; fi; \
	  ln -sfn "$$src" "$$dest" && echo "$$dest -> $$src"; \
	done
