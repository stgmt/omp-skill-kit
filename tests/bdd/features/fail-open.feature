Feature: Fail-open resilience
  Scenario: Bridge unavailable or timing out fails open gracefully
    Given an uninitialized or dead bridge endpoint
    When a routing request is attempted with a bounded deadline
    Then the router client returns unavailable without throwing
    And OMP execution continues without blocking the turn
