{
  description = "Dead Man's Dice — self-hosted Liar's Dice for a crew of friends";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        dead-mans-dice = pkgs.buildNpmPackage {
          pname = "dead-mans-dice";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-ilkyHHd86ycT98O3digKO6adK3oKeASf8gexS0MsakI=";

          dontNpmBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/dead-mans-dice
            cp -r . $out/lib/dead-mans-dice
            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/dead-mans-dice \
              --add-flags "$out/lib/dead-mans-dice/server.js"
            runHook postInstall
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];
        };
      in
      {
        packages.default = dead-mans-dice;

        apps.default = {
          type = "app";
          program = "${dead-mans-dice}/bin/dead-mans-dice";
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs ];
          shellHook = ''
            echo "Dead Man's Dice dev shell — run 'npm install' once, then 'npm start' (or 'node server.js')."
          '';
        };
      });
}
