# Shared deterministic fixtures

Every fixture is a decimal uint64 seed, dealer, names, and a sequence of
legal-move indices. Every move must include its engine-authored `expect`
description so an upstream enumeration change fails loudly instead of silently
repointing a script.

P1b starts with `opening.yaml`. The P2 loop adds the SPEC §7.3 scenario corpus
as the corresponding behavior is implemented; empty placeholder scripts are
not committed because they would provide false coverage.
