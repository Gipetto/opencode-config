.PHONY: init install check update

init: check install        # first run: verify, pre-warm, link
	nix build .#everything

install:
	./install.sh

check:
	nix flake check

update:                    # after any flake/pin change: bump inputs, pre-warm
	nix flake update
	nix build .#everything
