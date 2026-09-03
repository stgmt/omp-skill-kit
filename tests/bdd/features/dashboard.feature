Feature: Upstream mega-tron dashboard
  Scenario: Dashboard loopback launch, status check, and graceful shutdown
    Given an isolated home directory with active runtime
    When the dashboard is launched
    Then it binds to loopback port and responds to overview API
    And dashboard.json is saved atomically with runtime hash and PID
    And stopping the dashboard cleanly terminates the process
