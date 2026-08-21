from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from math import ceil
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin
import xml.etree.ElementTree as ET

import requests


NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dcterms": "http://purl.org/dc/terms/",
    "oslc": "http://open-services.net/ns/core#",
    "oslc_qm": "http://open-services.net/ns/qm#",
    "rqm_qm": "http://jazz.net/ns/qm/rqm#",
    "rtc": "http://jazz.net/xmlns/prod/jazz/rtc/1.0/"
    }


class OslcError(Exception):
    pass


@dataclass
class OslcConfig:
    qm_base_url: str
    jts_base_url: str
    timeout_seconds: int = 30
    verify_ssl: bool = True
    ca_bundle_path: Optional[str] = None
    page_size: int = 200


@dataclass
class QueryEndpoints:
    test_case_query: Optional[str] = None
    test_plan_query: Optional[str] = None
    test_result_query: Optional[str] = None


def _local(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _find_resource_attr(element: ET.Element) -> Optional[str]:
    return element.attrib.get(f"{{{NS['rdf']}}}resource")


def _extract_uri_value(element: ET.Element) -> Optional[str]:
    resource = _find_resource_attr(element)
    if resource:
        return resource
    if element.text and element.text.strip():
        return element.text.strip()
    return None


def _first_text(root: ET.Element, names: List[str]) -> Optional[str]:
    names_set = set(names)
    for elem in root.iter():
        if _local(elem.tag) in names_set:
            if elem.text and elem.text.strip():
                return elem.text.strip()
    return None


def estimate_rqm_api_calls(
    test_case_count: int,
    test_plan_count: int,
    test_result_count: int,
    page_size: int = 200,
) -> Dict[str, int]:
    auth_and_discovery = 5

    query_calls = (
        ceil(max(test_case_count, 0) / max(page_size, 1))
        + ceil(max(test_plan_count, 0) / max(page_size, 1))
        + ceil(max(test_result_count, 0) / max(page_size, 1))
    )

    detail_calls = max(test_case_count, 0) + max(test_plan_count, 0) + max(test_result_count, 0)

    return {
        "auth_and_discovery": auth_and_discovery,
        "query_pages": query_calls,
        "detail_fetches": detail_calls,
        "total_min_calls": auth_and_discovery + query_calls,
        "total_with_full_details": auth_and_discovery + query_calls + detail_calls,
    }


class JazzOslcClient:
    def __init__(self, config: OslcConfig, username: str, password: str):
        self.config = config
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.verify = config.ca_bundle_path if (config.verify_ssl and config.ca_bundle_path) else config.verify_ssl
        self.session.headers.update(
            {
                "Accept": "application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8",
                "OSLC-Core-Version": "2.0",
            }
        )
        self.query_endpoints = QueryEndpoints()
        self.discovery_candidates: List[Dict[str, Optional[str]]] = []

    @staticmethod
    def _classify_query_capability(resource_type_uri: Optional[str], query_base_uri: str) -> Optional[str]:
        rt = (resource_type_uri or "").lower()
        qb = (query_base_uri or "").lower()

        if "testcase" in rt or "versionedtestcase" in rt:
            return "test_case"
        if "testplan" in rt:
            return "test_plan"
        if "testresult" in rt or "testexecutionrecord" in rt or "executionresult" in rt:
            return "test_result"

        if "testcase" in qb or "versionedtestcase" in qb:
            return "test_case"
        if "testplan" in qb:
            return "test_plan"
        if "testresult" in qb or "testexecutionrecord" in qb or "executionresult" in qb:
            return "test_result"

        return None

    def _get(self, url: str, params: Optional[Dict[str, Any]] = None) -> requests.Response:
        response = self.session.get(url, params=params, timeout=self.config.timeout_seconds)
        response.raise_for_status()
        return response

    def _post(self, url: str, data: Dict[str, Any], allow_redirects: bool = False) -> requests.Response:
        response = self.session.post(
            url,
            data=data,
            timeout=self.config.timeout_seconds,
            allow_redirects=allow_redirects,
        )
        if response.status_code >= 400:
            raise OslcError(f"POST failed for {url}: HTTP {response.status_code}")
        return response

    def authenticate(self) -> None:
        identity_url = urljoin(self.config.jts_base_url.rstrip("/") + "/", "authenticated/identity")
        self.session.get(identity_url, timeout=self.config.timeout_seconds, allow_redirects=True)

        login_url = urljoin(self.config.jts_base_url.rstrip("/") + "/", "j_security_check")
        login_response = self._post(
            login_url,
            {
                "j_username": self.username,
                "j_password": self.password,
            },
            allow_redirects=True,
        )

        verify = self.session.get(identity_url, timeout=self.config.timeout_seconds, allow_redirects=True)
        if verify.status_code >= 400:
            raise OslcError(
                f"Jazz authentication verification failed (HTTP {verify.status_code}). "
                f"Login POST status: {login_response.status_code}"
            )

        verify_text = (verify.text or "").lower()
        auth_failure_markers = [
            "anonymous",
            "authenticationrequired",
            "authrequired",
            "login",
            "j_security_check",
        ]
        if any(marker in verify_text for marker in auth_failure_markers) and self.username.lower() not in verify_text:
            raise OslcError(
                "Jazz authentication verification failed. "
                "Credentials may be invalid, account may require different login context, or JTS base URL may be incorrect. "
                f"Identity URL checked: {identity_url}"
            )

    def discover_service_provider_catalog(self) -> str:
        rootservices_url = urljoin(self.config.qm_base_url.rstrip("/") + "/", "rootservices")
        xml_text = self._get(rootservices_url).text
        root = ET.fromstring(xml_text)

        for elem in root.iter():
            if _local(elem.tag) == "qmServiceProviders":
                catalog_uri = _find_resource_attr(elem)
                if catalog_uri:
                    return urljoin(rootservices_url, catalog_uri)

        raise OslcError("Unable to discover qmServiceProviders in rootservices")

    def discover_query_capabilities(self) -> QueryEndpoints:
        self.discovery_candidates = []
        catalog_uri = self.discover_service_provider_catalog()
        catalog_xml = self._get(catalog_uri).text
        root = ET.fromstring(catalog_xml)

        # Some Jazz deployments expose query capabilities directly at catalog level
        self._extract_query_endpoints(catalog_xml, base_uri=catalog_uri)

        service_provider_uris: List[str] = []
        for elem in root.iter():
            if _local(elem.tag) == "serviceProvider":
                uri = _find_resource_attr(elem)
                if uri:
                    service_provider_uris.append(urljoin(catalog_uri, uri))

        if not service_provider_uris:
            service_provider_uris.append(catalog_uri)

        for service_provider_uri in service_provider_uris:
            provider_xml = self._get(service_provider_uri).text
            self._extract_query_endpoints(provider_xml, base_uri=service_provider_uri)
            if (
                self.query_endpoints.test_case_query
                and self.query_endpoints.test_plan_query
                and self.query_endpoints.test_result_query
            ):
                break

        return self.query_endpoints

    def _extract_query_endpoints(self, provider_xml: str, base_uri: str) -> None:
        root = ET.fromstring(provider_xml)

        def add_candidate(resource_type_uri: Optional[str], query_base_uri: str, source: str) -> None:
            capability_kind = self._classify_query_capability(resource_type_uri, query_base_uri)
            candidate = {
                "resource_type": resource_type_uri,
                "query_base": query_base_uri,
                "kind": capability_kind,
                "source": source,
            }
            if candidate not in self.discovery_candidates:
                self.discovery_candidates.append(candidate)

            if capability_kind == "test_case" and not self.query_endpoints.test_case_query:
                self.query_endpoints.test_case_query = query_base_uri
            elif capability_kind == "test_plan" and not self.query_endpoints.test_plan_query:
                self.query_endpoints.test_plan_query = query_base_uri
            elif capability_kind == "test_result" and not self.query_endpoints.test_result_query:
                self.query_endpoints.test_result_query = query_base_uri

        def process_capability_node(node: ET.Element) -> None:
            resource_type_uri = None
            query_base_uri = None

            for child in list(node):
                child_local = _local(child.tag)
                if child_local == "resourceType":
                    resource_type_uri = _extract_uri_value(child)
                elif child_local == "queryBase":
                    query_base_uri = _extract_uri_value(child)

            if not query_base_uri:
                return

            query_base_uri = urljoin(base_uri, query_base_uri)
            add_candidate(resource_type_uri, query_base_uri, source="capability-node")

        for elem in root.iter():
            local_name = _local(elem.tag)

            if local_name in {"QueryCapability", "queryCapability"}:
                process_capability_node(elem)
                continue

            if local_name == "Description":
                has_query_base = any(_local(child.tag) == "queryBase" for child in list(elem))
                if has_query_base:
                    process_capability_node(elem)

        # Deep fallback: scan all queryBase nodes and infer kind from parent sibling resourceType and URL
        parent_map = {child: parent for parent in root.iter() for child in parent}
        for elem in root.iter():
            if _local(elem.tag) != "queryBase":
                continue

            raw_query_base = _extract_uri_value(elem)
            if not raw_query_base:
                continue

            query_base_uri = urljoin(base_uri, raw_query_base)
            parent = parent_map.get(elem)
            resource_type_uri = None
            if parent is not None:
                for sibling in list(parent):
                    if _local(sibling.tag) == "resourceType":
                        resource_type_uri = _extract_uri_value(sibling)
                        if resource_type_uri:
                            break

            add_candidate(resource_type_uri, query_base_uri, source="deep-querybase-scan")

    def oslc_query(
        self,
        query_base: str,
        where: Optional[str] = None,
        select: str = "*",
    ) -> List[str]:
        resource_uris: List[str] = []
        next_page: Optional[str] = query_base
        params: Dict[str, Any] = {
            "oslc.select": select,
            "oslc.pageSize": self.config.page_size,
        }
        if where:
            params["oslc.where"] = where

        while next_page:
            resp = self._get(next_page, params=params)
            xml_text = resp.text
            root = ET.fromstring(xml_text)

            for desc in root.findall(".//rdf:Description", NS):
                uri = desc.attrib.get(f"{{{NS['rdf']}}}about")
                if uri and "/oslc_qm/contexts/" in uri:
                    resource_uris.append(uri)

            next_page_uri = None
            for elem in root.iter():
                if _local(elem.tag) == "nextPage":
                    next_page_uri = _find_resource_attr(elem)
                    if next_page_uri:
                        next_page = urljoin(resp.url, next_page_uri)
                        break

            if not next_page_uri:
                next_page = None

            params = {}

        deduped = list(dict.fromkeys(resource_uris))
        return deduped

    def fetch_resource_summary(self, resource_uri: str) -> Dict[str, Any]:
        response = self._get(resource_uri)
        root = ET.fromstring(response.text)

        return {
            "uri": resource_uri,
            "identifier": _first_text(root, ["identifier"]),
            "title": _first_text(root, ["title", "name"]),
            "owner": _first_text(root, ["owner", "creator", "contributor"]),
            "status": _first_text(root, ["status", "state", "verdict"]),
            "plan": _first_text(root, ["testPlan", "plan"]),
            "executed_on": _first_text(root, ["executionTime", "created", "modified"]),
        }


class RqmRtcChatbotModule:
    def __init__(self, client: JazzOslcClient):
        self.client = client

    def initialize(self) -> QueryEndpoints:
        self.client.authenticate()
        return self.client.discover_query_capabilities()

    def _ensure_query_capabilities(self) -> None:
        endpoints = self.client.query_endpoints
        if endpoints.test_case_query and endpoints.test_plan_query and endpoints.test_result_query:
            return
        self.client.discover_query_capabilities()

    def get_test_case(self, test_case_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_query_capabilities()
        if not self.client.query_endpoints.test_case_query:
            raise OslcError("Test case query capability not discovered")

        where = f'dcterms:identifier="{test_case_id}"'
        uris = self.client.oslc_query(self.client.query_endpoints.test_case_query, where=where)
        if not uris:
            return None
        return self.client.fetch_resource_summary(uris[0])

    def get_test_plan(self, test_plan_identifier: str) -> Optional[Tuple[str, Dict[str, Any]]]:
        self._ensure_query_capabilities()
        if not self.client.query_endpoints.test_plan_query:
            raise OslcError("Test plan query capability not discovered")

        where = f'dcterms:identifier="{test_plan_identifier}"'
        uris = self.client.oslc_query(self.client.query_endpoints.test_plan_query, where=where)
        if not uris:
            return None
        first_uri = uris[0]
        return first_uri, self.client.fetch_resource_summary(first_uri)

    def list_test_cases_owned_by_user_in_plan(self, owner_name: str, test_plan_identifier: str) -> List[Dict[str, Any]]:
        plan_info = self.get_test_plan(test_plan_identifier)
        if not plan_info:
            return []

        plan_uri, _ = plan_info
        if not self.client.query_endpoints.test_case_query:
            raise OslcError("Test case query capability not discovered")

        where = f'oslc_qm:usesTestPlan="{plan_uri}"'
        uris = self.client.oslc_query(self.client.query_endpoints.test_case_query, where=where)

        filtered: List[Dict[str, Any]] = []
        owner_text = owner_name.strip().lower()
        for uri in uris:
            summary = self.client.fetch_resource_summary(uri)
            owner = (summary.get("owner") or "").lower()
            if owner_text in owner:
                filtered.append(summary)

        return filtered

    def list_test_cases_executed_on(self, execution_day: date) -> List[Dict[str, Any]]:
        self._ensure_query_capabilities()
        if not self.client.query_endpoints.test_result_query:
            raise OslcError("Test result query capability not discovered")

        uris = self.client.oslc_query(self.client.query_endpoints.test_result_query)
        day_start = datetime.combine(execution_day, datetime.min.time(), tzinfo=timezone.utc)
        day_end = datetime.combine(execution_day, datetime.max.time(), tzinfo=timezone.utc)

        executed: List[Dict[str, Any]] = []
        for uri in uris:
            summary = self.client.fetch_resource_summary(uri)
            raw_timestamp = summary.get("executed_on")
            if not raw_timestamp:
                continue

            try:
                normalized = raw_timestamp.replace("Z", "+00:00")
                executed_at = datetime.fromisoformat(normalized)
                if executed_at.tzinfo is None:
                    executed_at = executed_at.replace(tzinfo=timezone.utc)
                if day_start <= executed_at <= day_end:
                    executed.append(summary)
            except Exception:
                continue

        return executed

    def list_failed_test_cases_in_plan(self, test_plan_identifier: str) -> List[Dict[str, Any]]:
        self._ensure_query_capabilities()
        plan_info = self.get_test_plan(test_plan_identifier)
        if not plan_info:
            return []

        plan_uri, _ = plan_info
        if not self.client.query_endpoints.test_result_query:
            raise OslcError("Test result query capability not discovered")

        where = f'oslc_qm:usesTestPlan="{plan_uri}"'
        result_uris = self.client.oslc_query(self.client.query_endpoints.test_result_query, where=where)

        failed: List[Dict[str, Any]] = []
        for uri in result_uris:
            summary = self.client.fetch_resource_summary(uri)
            status = (summary.get("status") or "").lower()
            if "fail" in status or "error" in status:
                failed.append(summary)

        return failed


def create_module_with_existing_login(
    qm_base_url: str,
    jts_base_url: str,
    username: str,
    password: str,
    verify_ssl: bool = True,
    ca_bundle_path: Optional[str] = None,
) -> RqmRtcChatbotModule:
    config = OslcConfig(
        qm_base_url=qm_base_url,
        jts_base_url=jts_base_url,
        verify_ssl=verify_ssl,
        ca_bundle_path=ca_bundle_path,
    )
    client = JazzOslcClient(config=config, username=username, password=password)
    return RqmRtcChatbotModule(client)
