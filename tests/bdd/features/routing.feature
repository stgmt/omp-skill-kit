Feature: Semantic routing and tool execution
  Scenario: Router client provides names-only hint and model executes real tool read
    Given an active loopback model server
    And a mock bridge responding with fixture candidates
    When a user prompt is routed through the client
    Then the client returns sanitized candidate skill names
    And the system prompt receives only a names-only hint block
    And no skill descriptions, file paths, or bodies leak into the prompt
