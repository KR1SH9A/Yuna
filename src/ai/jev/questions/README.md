# Jev question preparation

This directory is reserved for reusable provider question formatting once implementation begins. It contains no prompts or executable code yet.

Feature owners define the question meaning, evidence requirements, exclusions and policy version. Jev owns mapping the prepared question to the provider's supported question/answer types. Keep the original text and observation coverage explicit.

A future question helper may format a prepared question and validate its answer shape. It must not load a case, choose a sanction, look up permissions, or call the LLM. Put a feature-specific rule change and its evaluation fixtures with that feature.
