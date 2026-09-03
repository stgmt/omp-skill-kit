Feature: Clean container environment
  Scenario: Non-root user operation and offline reuse
    Given a minimal standalone environment without external Python or uv
    When the plugin runs in an isolated workspace
    Then all data is contained strictly within the skill kit home
    And offline reuse succeeds without external network requests
