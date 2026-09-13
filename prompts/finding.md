Submit one durable, structured review finding for an existing prepared run.

Use `agentic_code_review_append_finding` only with the supplied session and run IDs. Submit evidence collected by inspecting the code and its contracts. Do not read or edit the shared review artifacts to submit a finding; this tool owns that update.

New runs require `humanReadable` (about 25–40 plain-language words, at most 400 characters) and a one-letter `rating`: A safest, B minor improvements, C bounded concern, D blocker or material missing proof, E confirmed serious failure, F confirmed critical failure. Keep uncertainty and origin explicit; a rating is not proof or an automatic blocker. Old runs may omit both fields. The tool records actual model/thinking metadata from the executing context; do not supply attribution yourself.

Classify confirmed defects as `bug`; they require expected and actual behavior, origin, blocking status, verification, and concrete evidence. Use `fix` or `nit` only for nonblocking suggestions. The tool validates record shape and persistence only; it does not prove the finding semantically.
