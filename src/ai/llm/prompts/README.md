# LLM template ownership

This directory is reserved for versioned observation, reply and explanation templates. No model prompts or runtime code are implemented yet.

The requesting feature prepares authorized inputs and selects the task's template/schema version. Templates format that input for a bounded operation; they do not retrieve arbitrary context, choose workflow stages, or grant permission to execute an action.

Keep policy instructions separate from untrusted messages, quotes and reports. Observation templates preserve coverage gaps. Explanation templates describe accepted findings without revising them. Store template/model versions on tasks so a configuration update cannot silently change work already issued.
