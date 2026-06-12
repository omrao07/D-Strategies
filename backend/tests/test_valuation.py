# test_valuation.py
# Pytest test suite for backend/valuation/schemas.py
#
# Tests:
#   - CompanyId ticker normalization (lowercase → uppercase)
#   - CompanyId empty ticker raises ValueError
#   - Fundamentals with negative shares_diluted raises ValueError
#   - MarketSnapshot auto-computes market_cap from price × shares
#   - DCFInputsSchema terminal_growth >= wacc raises ValueError (perpetuity)
#   - DCFInputsSchema multiple method with missing exit_multiple raises ValueError
#   - ValuationPackage.summary() returns expected keys
#
# Run:
#   pytest -q backend/tests/test_valuation.py

from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from backend.valuation.schemas import (
    CompanyId,
    Currency,
    DCFInputsSchema,
    DCFResultSchema,
    Fundamentals,
    MarketSnapshot,
    TerminalMethod,
    ValuationMethod,
    ValuationPackage,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_TODAY = date(2026, 1, 15)


def _company(**kwargs) -> CompanyId:
    defaults = dict(ticker="AAPL")
    defaults.update(kwargs)
    return CompanyId(**defaults)


# ---------------------------------------------------------------------------
# 1. CompanyId ticker normalization
# ---------------------------------------------------------------------------

class TestCompanyIdTickerNorm:
    def test_lowercase_is_uppercased(self):
        c = CompanyId(ticker="aapl")
        assert c.ticker == "AAPL"

    def test_mixed_case_is_uppercased(self):
        c = CompanyId(ticker="rElIaNcE")
        assert c.ticker == "RELIANCE"

    def test_already_uppercase_unchanged(self):
        c = CompanyId(ticker="MSFT")
        assert c.ticker == "MSFT"

    def test_whitespace_stripped_and_uppercased(self):
        c = CompanyId(ticker="  tsla  ")
        assert c.ticker == "TSLA"

    def test_dot_suffix_preserved(self):
        """NSE tickers like RELIANCE.NS should keep the dot."""
        c = CompanyId(ticker="reliance.ns")
        assert c.ticker == "RELIANCE.NS"

    def test_optional_fields_default_to_none(self):
        c = CompanyId(ticker="GOOG")
        assert c.name is None
        assert c.exchange is None
        assert c.isin is None

    def test_currency_defaults_to_usd(self):
        c = CompanyId(ticker="GOOG")
        assert c.currency == Currency.USD


# ---------------------------------------------------------------------------
# 2. CompanyId empty ticker raises ValueError
# ---------------------------------------------------------------------------

class TestCompanyIdEmptyTicker:
    def test_empty_string_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            CompanyId(ticker="")
        assert "empty" in str(exc_info.value).lower()

    def test_whitespace_only_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            CompanyId(ticker="   ")
        assert "empty" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# 3. Fundamentals with negative shares_diluted raises ValueError
# ---------------------------------------------------------------------------

class TestFundamentalsValidation:
    def test_positive_shares_diluted_accepted(self):
        f = Fundamentals(as_of=_TODAY, shares_diluted=1_000_000.0)
        assert f.shares_diluted == 1_000_000.0

    def test_none_shares_diluted_accepted(self):
        f = Fundamentals(as_of=_TODAY, shares_diluted=None)
        assert f.shares_diluted is None

    def test_negative_shares_diluted_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            Fundamentals(as_of=_TODAY, shares_diluted=-500.0)
        assert "shares_diluted" in str(exc_info.value)

    def test_zero_shares_diluted_raises(self):
        """shares_diluted must be > 0, so 0 is also invalid."""
        with pytest.raises(ValidationError):
            Fundamentals(as_of=_TODAY, shares_diluted=0.0)

    def test_other_fields_accept_negative(self):
        """Net debt and wc_change can legitimately be negative."""
        f = Fundamentals(as_of=_TODAY, net_debt=-1000.0, wc_change=-50.0)
        assert f.net_debt == -1000.0
        assert f.wc_change == -50.0


# ---------------------------------------------------------------------------
# 4. MarketSnapshot auto-computes market_cap
# ---------------------------------------------------------------------------

class TestMarketSnapshotAutoCompute:
    def test_market_cap_auto_computed(self):
        snap = MarketSnapshot(
            as_of=_TODAY,
            price=150.0,
            shares_outstanding=1_000_000.0,
        )
        assert snap.market_cap == pytest.approx(150.0 * 1_000_000.0)

    def test_explicit_market_cap_not_overwritten(self):
        """If market_cap is provided, do NOT overwrite it."""
        snap = MarketSnapshot(
            as_of=_TODAY,
            price=150.0,
            shares_outstanding=1_000_000.0,
            market_cap=99_999.0,
        )
        assert snap.market_cap == pytest.approx(99_999.0)

    def test_market_cap_none_when_no_shares(self):
        """Without shares_outstanding, market_cap stays None."""
        snap = MarketSnapshot(as_of=_TODAY, price=150.0)
        assert snap.market_cap is None

    def test_price_must_be_positive(self):
        with pytest.raises(ValidationError):
            MarketSnapshot(as_of=_TODAY, price=0.0)

    def test_price_negative_raises(self):
        with pytest.raises(ValidationError):
            MarketSnapshot(as_of=_TODAY, price=-10.0)

    def test_integer_price_and_shares_accepted(self):
        snap = MarketSnapshot(as_of=_TODAY, price=200, shares_outstanding=500)
        assert snap.market_cap == pytest.approx(100_000.0)


# ---------------------------------------------------------------------------
# 5. DCFInputsSchema — terminal_growth >= wacc raises ValueError (perpetuity)
# ---------------------------------------------------------------------------

class TestDCFInputsSchemaPerpetuity:
    def _base(self, **kwargs) -> dict:
        defaults = dict(
            fcfs=[100.0, 110.0, 121.0],
            wacc=0.10,
            terminal_growth=0.03,
            terminal_method=TerminalMethod.PERPETUITY,
        )
        defaults.update(kwargs)
        return defaults

    def test_valid_perpetuity_accepted(self):
        inp = DCFInputsSchema(**self._base())
        assert inp.wacc == pytest.approx(0.10)
        assert inp.terminal_growth == pytest.approx(0.03)

    def test_terminal_growth_equal_to_wacc_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            DCFInputsSchema(**self._base(terminal_growth=0.10, wacc=0.10))
        assert "terminal_growth" in str(exc_info.value).lower() or "wacc" in str(exc_info.value).lower()

    def test_terminal_growth_greater_than_wacc_raises(self):
        with pytest.raises(ValidationError):
            DCFInputsSchema(**self._base(terminal_growth=0.15, wacc=0.10))

    def test_terminal_growth_just_below_wacc_accepted(self):
        inp = DCFInputsSchema(**self._base(terminal_growth=0.0999, wacc=0.10))
        assert inp.terminal_growth == pytest.approx(0.0999)

    def test_negative_terminal_growth_accepted(self):
        inp = DCFInputsSchema(**self._base(terminal_growth=-0.01))
        assert inp.terminal_growth == pytest.approx(-0.01)

    def test_wacc_must_be_positive(self):
        with pytest.raises(ValidationError):
            DCFInputsSchema(**self._base(wacc=0.0))


# ---------------------------------------------------------------------------
# 6. DCFInputsSchema — multiple method with missing exit_multiple raises
# ---------------------------------------------------------------------------

class TestDCFInputsSchemaMultiple:
    def _base_multiple(self, **kwargs) -> dict:
        defaults = dict(
            fcfs=[100.0, 110.0],
            wacc=0.10,
            terminal_method=TerminalMethod.MULTIPLE,
            exit_multiple=8.0,
            ebitda_terminal=50.0,
        )
        defaults.update(kwargs)
        return defaults

    def test_valid_multiple_method_accepted(self):
        inp = DCFInputsSchema(**self._base_multiple())
        assert inp.exit_multiple == pytest.approx(8.0)
        assert inp.ebitda_terminal == pytest.approx(50.0)

    def test_missing_exit_multiple_raises(self):
        with pytest.raises(ValidationError) as exc_info:
            DCFInputsSchema(**self._base_multiple(exit_multiple=None))
        assert "exit_multiple" in str(exc_info.value).lower() or "multiple" in str(exc_info.value).lower()

    def test_missing_ebitda_terminal_raises(self):
        with pytest.raises(ValidationError):
            DCFInputsSchema(**self._base_multiple(ebitda_terminal=None))

    def test_both_missing_raises(self):
        with pytest.raises(ValidationError):
            DCFInputsSchema(**self._base_multiple(exit_multiple=None, ebitda_terminal=None))

    def test_multiple_method_ignores_terminal_growth_vs_wacc(self):
        """For multiple method, terminal_growth vs wacc check should NOT apply."""
        inp = DCFInputsSchema(**self._base_multiple(terminal_growth=0.20, wacc=0.10))
        assert inp.terminal_method == TerminalMethod.MULTIPLE


# ---------------------------------------------------------------------------
# 7. ValuationPackage.summary() returns expected keys
# ---------------------------------------------------------------------------

class TestValuationPackageSummary:
    def _make_package(self, with_market=False, with_dcf=False) -> ValuationPackage:
        company = _company(ticker="TSLA")
        pkg = ValuationPackage(company=company, as_of=_TODAY)

        if with_market:
            pkg.market = MarketSnapshot(
                as_of=_TODAY,
                price=250.0,
                shares_outstanding=3_000_000.0,
            )

        if with_dcf:
            dcf_inputs = DCFInputsSchema(
                fcfs=[500.0, 550.0, 600.0],
                wacc=0.09,
                terminal_growth=0.03,
                terminal_method=TerminalMethod.PERPETUITY,
                net_debt=100.0,
                shares_outstanding=3_000_000.0,
            )
            pkg.dcf_inputs = dcf_inputs
            pkg.dcf_result = DCFResultSchema(
                inputs=dcf_inputs,
                enterprise_value=10_000.0,
                equity_value=9_900.0,
                price_per_share=3.30,
                as_of=_TODAY,
                method=ValuationMethod.DCF,
            )

        return pkg

    def test_summary_always_has_base_keys(self):
        pkg = self._make_package()
        s = pkg.summary()
        for key in ("schema", "ticker", "as_of", "currency"):
            assert key in s, f"Missing key: {key}"

    def test_summary_ticker_is_normalized(self):
        pkg = self._make_package()
        s = pkg.summary()
        assert s["ticker"] == "TSLA"

    def test_summary_as_of_is_isoformat(self):
        pkg = self._make_package()
        s = pkg.summary()
        assert s["as_of"] == _TODAY.isoformat()

    def test_summary_no_market_cap_when_market_absent(self):
        pkg = self._make_package(with_market=False)
        s = pkg.summary()
        assert "market_cap" not in s

    def test_summary_market_cap_present_when_market_provided(self):
        pkg = self._make_package(with_market=True)
        s = pkg.summary()
        assert "market_cap" in s
        assert s["market_cap"] == pytest.approx(250.0 * 3_000_000.0)

    def test_summary_no_dcf_keys_when_absent(self):
        pkg = self._make_package()
        s = pkg.summary()
        for key in ("ev", "eq", "px"):
            assert key not in s

    def test_summary_dcf_keys_present_when_dcf_provided(self):
        pkg = self._make_package(with_dcf=True)
        s = pkg.summary()
        assert "ev" in s
        assert "eq" in s
        assert "px" in s
        assert s["ev"] == pytest.approx(10_000.0)
        assert s["eq"] == pytest.approx(9_900.0)
        assert s["px"] == pytest.approx(3.30)

    def test_summary_currency_value(self):
        pkg = self._make_package()
        s = pkg.summary()
        assert s["currency"] == "USD"
