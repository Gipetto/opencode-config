{
  description = "Vendored agent tooling for ~/.config/opencode (kindex, gitnexus, sim, advocate, meditate, pact, signet-eval)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/0dd31db7e6dbf9ce05697c4545f6fe01accec994";
    flake-utils.url = "github:numtide/flake-utils";

    kindex.url = "github:wandercom/kindex/c77b1f16dd25511862e07c2f2b1d292a0decaa50";
    kindex.flake = false;
  };

  outputs = { self, nixpkgs, flake-utils, kindex }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        isDarwin = pkgs.stdenv.hostPlatform.isDarwin;

        # GitNexus — Graph-powered code intelligence for AI agents.
        gitnexus = pkgs.buildNpmPackage {
          pname = "gitnexus";
          version = "1.6.10-rc.211";

          src = pkgs.fetchgit {
            url = "https://github.com/abhigyanpatwari/GitNexus.git";
            rev = "aeb3b0e439020ebf83c92529cb5088b8c9682517"; # tag v1.6.10-rc.211 (dereferenced to its commit)
            hash = "sha256-K53EYpxi5cyfV9DPYkqeVThIBz0yGvBv7/e/0XSrvow=";
            name = "GitNexus"; # stable basename for sourceRoot; fetch output must stay ./GitNexus
          };

          sourceRoot = "GitNexus/gitnexus";

          npmDepsHash = "sha256-v+Q1dBoD7+7U9HbrwIUvT93OHT7A4nMGXvrZmlDE8WU=";

          nativeBuildInputs = with pkgs; [
            python3
            pkg-config
          ] ++ pkgs.lib.optionals isDarwin [ makeWrapper ];

          nodejs = pkgs.nodejs_22;

          npmBuildScript = "build";

          # Dependency lifecycle scripts may download platform binaries. Run
          # only GitNexus's offline vendored-grammar setup explicitly below.
          npmFlags = [ "--ignore-scripts" ];

          postPatch = ''
            substituteInPlace scripts/build.js \
              --replace-fail \
                "const SHARED_ROOT = path.resolve(ROOT, '..', 'gitnexus-shared');" \
                "const SHARED_ROOT = path.resolve(ROOT, 'gitnexus-shared');" \
              --replace-fail \
                "if (fs.existsSync(path.join(WEB_ROOT, 'package.json'))) {" \
                "if (false) {"
          '';

          preBuild = ''
            cp -R ../gitnexus-shared ./gitnexus-shared
            chmod -R u+w ./gitnexus-shared
            ln -s ../node_modules ./gitnexus-shared/node_modules
            rm ./node_modules/gitnexus-shared
            ln -s ../gitnexus-shared ./node_modules/gitnexus-shared

            node scripts/build-tree-sitter-grammars.cjs
          '';

          preInstall = ''
            rm ./node_modules/gitnexus-shared
            rm -rf ./gitnexus-shared
          '';

          postInstall = ''
            pushd "$out/lib/node_modules/gitnexus"
            node node_modules/@ladybugdb/core/install.js
            node scripts/build-tree-sitter-grammars.cjs
            popd
          '';

          # LadybugDB's macOS rpaths cover Homebrew and MacPorts, but not Nix.
          postFixup = pkgs.lib.optionalString isDarwin ''
            wrapProgram "$out/bin/gitnexus" \
              --prefix DYLD_FALLBACK_LIBRARY_PATH : ${pkgs.openssl.out}/lib
          '';

          meta = {
            description = "Graph-powered code intelligence for AI agents";
            homepage = "https://github.com/abhigyanpatwari/GitNexus";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # Kindex — persistent knowledge graph CLI + MCP server (kin, kin-mcp).
        # The provider-default patch sources kindex's config provider default from LOCAL_LLM_PROVIDER.
        kindex-pkg = pkgs.python3Packages.buildPythonApplication rec {
          pname = "kindex";
          version = "0.46.0";
          pyproject = true;

          src = kindex;

          patches = [ ./patches/kindex-wrapper-provider-default.patch ];

          build-system = [ pkgs.python3Packages.hatchling ];

          dependencies = with pkgs.python3Packages; [
            pydantic
            pyyaml
            networkx
            numpy
            python-dateutil
            anthropic
            cronsim
            dateparser
            mcp
            sqlite-vec
            rfc8785
            cryptography
          ];

          doCheck = false;

          meta = {
            description = "Persistent knowledge graph for AI workflows (kin, kin-mcp)";
            homepage = "https://github.com/wandercom/kindex";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };

        anthropic-meditate = pkgs.python3Packages.anthropic.overridePythonAttrs (_old: rec {
          version = "0.122.0";

          src = pkgs.fetchPypi {
            pname = "anthropic";
            inherit version;
            hash = "sha256-/+xWrpZlfI0Z+ldeyW8UDzgMNToHq31huS6xjuZTZgE=";
          };

          postPatch = (_old.postPatch or "") + ''
            substituteInPlace src/anthropic/lib/tools/agent_toolset.py \
              --replace-fail '"/bin/bash"' '"${pkgs.bash}/bin/bash"'
          '';
        });

        # Meditate — recoverable consolidation for Claude and Codex directives.
        meditate = pkgs.python3Packages.buildPythonApplication rec {
          pname = "meditate-agent";
          version = "0.1.0";
          pyproject = true;

          src = pkgs.fetchFromGitHub {
            owner = "wandercom";
            repo = "meditate";
            rev = "8e52dbfef1aa76de137647a213678998e34113af";
            hash = "sha256-+V//v1UkQSyv6vKcNOXo6pLqsnKLeC0/T+/IQHFkVJ0=";
          };

          build-system = [ pkgs.python3Packages.hatchling ];
          dependencies = [ anthropic-meditate ];
          nativeCheckInputs = [ pkgs.python3Packages.pytestCheckHook ];
          pythonImportsCheck = [ "meditate" ];

          meta = {
            description = "Recoverable consolidation of Claude and Codex behavioral directives";
            homepage = "https://github.com/wandercom/meditate";
            license = pkgs.lib.licenses.mit;
            mainProgram = "meditate";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # PACT — contract-first multi-agent software engineering framework (pact).
        pact = pkgs.python3Packages.buildPythonApplication rec {
          pname = "pact-agents";
          version = "1.2.0";
          pyproject = true;

          src = pkgs.fetchPypi {
            pname = "pact_agents";
            inherit version;
            hash = "sha256-uZN+nC3zTKzmqaPoMdX0obhlCAAkDSjm/eqpJEMc8mM=";
          };

          build-system = [ pkgs.python3Packages.hatchling ];

          dependencies = with pkgs.python3Packages; [
            pydantic
            pyyaml
            anthropic
            openai
            google-genai
            mcp
          ];

          doCheck = false;

          meta = {
            description = "Contract-first multi-agent software engineering (pact, pact-mcp)";
            homepage = "https://github.com/jmcentire/pact";
            license = pkgs.lib.licenses.mit;
            mainProgram = "pact";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # Transmogrifier — library dependency of advocate; not exposed as a package.
        transmogrifier = pkgs.python3Packages.buildPythonPackage rec {
          pname = "transmogrifier";
          version = "0.3.0";
          pyproject = true;

          src = pkgs.fetchFromGitHub {
            owner = "wandercom";
            repo = "transmogrifier";
            rev = "3be5178bb3bed7a5218b66679d6ca9c88b11f6a9";
            hash = "sha256-59b0jFgi0Ugv8a6YUwMJ0Ej1Bh6ob6rOvoZ8yz/aSSw=";
          };

          build-system = [ pkgs.python3Packages.hatchling ];

          dependencies = with pkgs.python3Packages; [
            pydantic
            pyyaml
            anthropic
            openai
            google-genai
            mcp
          ];

          doCheck = false;

          meta = {
            description = "Register-aware prompt translation (transmogrify, transmog-mcp)";
            homepage = "https://github.com/wandercom/transmogrifier";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };

        # Advocate — six-persona adversarial review engine.
        advocate = pkgs.python3Packages.buildPythonApplication rec {
          pname = "advocate";
          version = "0.1.5";
          pyproject = true;

          src = pkgs.fetchFromGitHub {
            owner = "jmcentire";
            repo = "advocate";
            rev = "12d595c9eaf86bdd14a4808bafa7c1a72dcfa6b5";
            hash = "sha256-GNE7WunmX6DD2+V3Sk6d0eAqNwwC7XDe0f5FI6JGQhY=";
          };

          build-system = [ pkgs.python3Packages.hatchling ];

          dependencies = (with pkgs.python3Packages; [
            click
            jinja2
            pydantic
            pyyaml
            anthropic
            openai
            google-genai
          ]) ++ [ transmogrifier ];

          doCheck = false;

          meta = {
            description = "Six-persona adversarial review engine (advocate)";
            homepage = "https://github.com/jmcentire/advocate";
            license = pkgs.lib.licenses.mit;
            mainProgram = "advocate";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # Simulacrum — Jeremy-style adversarial architecture and idea review (sim).
        simulacrumPython = pkgs.python3.withPackages (pythonPackages: with pythonPackages; [
          anthropic
          openai
        ]);

        sim = pkgs.stdenvNoCC.mkDerivation {
          pname = "simulacrum";
          version = "0-d5db92b";

          src = pkgs.fetchFromGitHub {
            owner = "wandercom";
            repo = "simulacrum";
            rev = "d5db92bb4e528c99434352a7df520900c790159f";
            hash = "sha256-tnwMrqrAQ/ee89A9BiHPT7HbaucKHCp9+g1QawAj5z0=";
          };

          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -Dm755 run.py "$out/libexec/simulacrum/run.py"
            install -d "$out/libexec/simulacrum/fly_v8"
            cp -r fly_v8/agents "$out/libexec/simulacrum/fly_v8/agents"
            install -Dm644 fly_v8/data/adversarial_pairs_annotated.json \
              "$out/libexec/simulacrum/fly_v8/data/adversarial_pairs_annotated.json"
            PYTHONPATH="$out/libexec/simulacrum/fly_v8" ${simulacrumPython}/bin/python -c \
              "from agents.dispatcher import Dispatcher"
            makeWrapper ${simulacrumPython}/bin/python "$out/bin/sim" \
              --add-flags "$out/libexec/simulacrum/run.py" \
              --run 'if [ -z "''${OPENAI_API_KEY:-}" ]; then unset GENERALIST_MODEL; fi'
            runHook postInstall
          '';

          meta = {
            description = "Jeremy-style adversarial review CLI (sim)";
            homepage = "https://github.com/wandercom/simulacrum";
            license = pkgs.lib.licenses.mit;
            mainProgram = "sim";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # signet-eval — deterministic authorization for AI agent tool calls.
        signet-eval = pkgs.rustPlatform.buildRustPackage rec {
          pname = "signet-eval";
          version = "3.12.0";

          src = pkgs.fetchFromGitHub {
            owner = "jmcentire";
            repo = "signet-eval";
            rev = "e751cb9e18bbcae3eb4aad9f2cd7985bb714dce5";
            hash = "sha256-AIocJ9DeNgK8jU+UxLTLCLXz7/hlLOz/3qwFmkssP9s=";
          };

          cargoLock.lockFile = "${src}/Cargo.lock";

          doCheck = false;

          meta = {
            description = "Deterministic authorization for AI agent tool calls";
            homepage = "https://github.com/jmcentire/signet-eval";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };
        perSystemPackages = {
          # One derivation provides both kin and kin-mcp.
          kindex = kindex-pkg;
          kindex-mcp = kindex-pkg;
          gitnexus = gitnexus;
          inherit sim advocate meditate pact;
          inherit signet-eval;
        };
      in
      {
        packages = perSystemPackages // {
          everything = pkgs.releaseTools.aggregate {
            name = "agent-tooling";
            constituents = builtins.attrValues perSystemPackages;
          };
        };
      });
}
