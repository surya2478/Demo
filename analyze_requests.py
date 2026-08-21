#!/usr/bin/env python3
"""
Request Tracker Analysis Script
Analyzes exported request tracker JSON data

Usage:
    python analyze_requests.py <json_file>
    python analyze_requests.py request-tracker-2026-01-08.json

Output:
    - Summary statistics
    - Tab breakdown
    - Endpoint analysis
    - Performance metrics
    - Error analysis
"""

import json
import sys
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Any

def load_data(filepath: str) -> Dict:
    """Load request tracker JSON export"""
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)

def analyze_summary(data: Dict) -> Dict:
    """Generate overall summary"""
    logs = data.get('logs', [])
    total = len(logs)
    
    successful = sum(1 for log in logs if log.get('responseStatus', 0) in range(200, 300))
    failed = sum(1 for log in logs if log.get('error') or log.get('responseStatus', 0) >= 400)
    pending = total - successful - failed
    
    return {
        'total': total,
        'successful': successful,
        'failed': failed,
        'pending': pending,
        'success_rate': (successful / total * 100) if total > 0 else 0
    }

def analyze_by_tab(data: Dict) -> Dict[str, Dict]:
    """Analyze requests by tab"""
    logs = data.get('logs', [])
    tab_stats = defaultdict(lambda: {
        'total': 0,
        'successful': 0,
        'failed': 0,
        'durations': [],
        'endpoints': defaultdict(int)
    })
    
    for log in logs:
        tab = log.get('tab', 'unknown')
        tab_stats[tab]['total'] += 1
        
        status = log.get('responseStatus', 0)
        if status in range(200, 300):
            tab_stats[tab]['successful'] += 1
        elif log.get('error') or status >= 400:
            tab_stats[tab]['failed'] += 1
        
        if log.get('duration'):
            tab_stats[tab]['durations'].append(log['duration'])
        
        endpoint = log.get('endpoint', 'unknown')
        tab_stats[tab]['endpoints'][endpoint] += 1
    
    # Calculate averages
    for tab, stats in tab_stats.items():
        durations = stats['durations']
        stats['avg_duration'] = sum(durations) / len(durations) if durations else 0
        stats['min_duration'] = min(durations) if durations else 0
        stats['max_duration'] = max(durations) if durations else 0
        del stats['durations']  # Remove raw data
    
    return dict(tab_stats)

def analyze_endpoints(data: Dict) -> List[Dict]:
    """Analyze most requested endpoints"""
    logs = data.get('logs', [])
    endpoint_stats = defaultdict(lambda: {
        'count': 0,
        'successful': 0,
        'failed': 0,
        'durations': []
    })
    
    for log in logs:
        endpoint = log.get('endpoint', 'unknown')
        endpoint_stats[endpoint]['count'] += 1
        
        status = log.get('responseStatus', 0)
        if status in range(200, 300):
            endpoint_stats[endpoint]['successful'] += 1
        elif log.get('error') or status >= 400:
            endpoint_stats[endpoint]['failed'] += 1
        
        if log.get('duration'):
            endpoint_stats[endpoint]['durations'].append(log['duration'])
    
    # Calculate averages and format
    result = []
    for endpoint, stats in endpoint_stats.items():
        durations = stats['durations']
        result.append({
            'endpoint': endpoint,
            'count': stats['count'],
            'successful': stats['successful'],
            'failed': stats['failed'],
            'success_rate': (stats['successful'] / stats['count'] * 100) if stats['count'] > 0 else 0,
            'avg_duration': sum(durations) / len(durations) if durations else 0
        })
    
    return sorted(result, key=lambda x: x['count'], reverse=True)

def analyze_errors(data: Dict) -> List[Dict]:
    """Analyze failed requests"""
    logs = data.get('logs', [])
    errors = []
    
    for log in logs:
        if log.get('error') or (log.get('responseStatus', 0) >= 400):
            errors.append({
                'timestamp': log.get('timestamp'),
                'tab': log.get('tab'),
                'method': log.get('method'),
                'endpoint': log.get('endpoint'),
                'status': log.get('responseStatus'),
                'error': log.get('error'),
                'duration': log.get('duration')
            })
    
    return errors

def analyze_performance(data: Dict) -> Dict:
    """Analyze performance metrics"""
    logs = data.get('logs', [])
    durations = [log.get('duration', 0) for log in logs if log.get('duration')]
    
    if not durations:
        return {
            'avg': 0,
            'min': 0,
            'max': 0,
            'median': 0,
            'p95': 0,
            'p99': 0
        }
    
    durations_sorted = sorted(durations)
    n = len(durations_sorted)
    
    return {
        'avg': sum(durations) / len(durations),
        'min': min(durations),
        'max': max(durations),
        'median': durations_sorted[n // 2],
        'p95': durations_sorted[int(n * 0.95)] if n > 0 else 0,
        'p99': durations_sorted[int(n * 0.99)] if n > 0 else 0
    }

def analyze_time_distribution(data: Dict) -> Dict:
    """Analyze request distribution over time"""
    logs = data.get('logs', [])
    hourly = defaultdict(int)
    
    for log in logs:
        try:
            timestamp = datetime.fromisoformat(log.get('timestamp', '').replace('Z', '+00:00'))
            hour = timestamp.strftime('%Y-%m-%d %H:00')
            hourly[hour] += 1
        except:
            pass
    
    return dict(sorted(hourly.items()))

def print_report(data: Dict):
    """Print comprehensive analysis report"""
    print("\n" + "="*70)
    print("REQUEST TRACKER ANALYSIS REPORT")
    print("="*70)
    print(f"\nExported At: {data.get('exportedAt', 'N/A')}")
    
    # Summary
    print("\n" + "-"*70)
    print("SUMMARY")
    print("-"*70)
    summary = analyze_summary(data)
    print(f"Total Requests:      {summary['total']}")
    print(f"Successful:          {summary['successful']} ({summary['success_rate']:.1f}%)")
    print(f"Failed:              {summary['failed']}")
    print(f"Pending:             {summary['pending']}")
    
    # Performance
    print("\n" + "-"*70)
    print("PERFORMANCE METRICS")
    print("-"*70)
    perf = analyze_performance(data)
    print(f"Average Duration:    {perf['avg']:.2f}ms")
    print(f"Min Duration:        {perf['min']:.2f}ms")
    print(f"Max Duration:        {perf['max']:.2f}ms")
    print(f"Median:              {perf['median']:.2f}ms")
    print(f"95th Percentile:     {perf['p95']:.2f}ms")
    print(f"99th Percentile:     {perf['p99']:.2f}ms")
    
    # By Tab
    print("\n" + "-"*70)
    print("ANALYSIS BY TAB")
    print("-"*70)
    tab_stats = analyze_by_tab(data)
    for tab, stats in sorted(tab_stats.items()):
        success_rate = (stats['successful'] / stats['total'] * 100) if stats['total'] > 0 else 0
        print(f"\n{tab.upper()}:")
        print(f"  Total:           {stats['total']}")
        print(f"  Successful:      {stats['successful']} ({success_rate:.1f}%)")
        print(f"  Failed:          {stats['failed']}")
        print(f"  Avg Duration:    {stats['avg_duration']:.2f}ms")
        print(f"  Top Endpoints:")
        for endpoint, count in sorted(stats['endpoints'].items(), key=lambda x: x[1], reverse=True)[:3]:
            print(f"    {endpoint}: {count} requests")
    
    # Top Endpoints
    print("\n" + "-"*70)
    print("TOP 10 ENDPOINTS")
    print("-"*70)
    endpoints = analyze_endpoints(data)[:10]
    for ep in endpoints:
        print(f"\n{ep['endpoint']}")
        print(f"  Requests:        {ep['count']}")
        print(f"  Success Rate:    {ep['success_rate']:.1f}%")
        print(f"  Avg Duration:    {ep['avg_duration']:.2f}ms")
    
    # Errors
    print("\n" + "-"*70)
    print("FAILED REQUESTS")
    print("-"*70)
    errors = analyze_errors(data)
    if errors:
        print(f"Total Failed: {len(errors)}\n")
        for err in errors[:10]:  # Show first 10
            print(f"[{err['timestamp']}] {err['tab'].upper()} - {err['method']} {err['endpoint']}")
            print(f"  Status: {err['status']} | Error: {err.get('error', 'N/A')}")
    else:
        print("No failed requests!")
    
    # Time Distribution
    print("\n" + "-"*70)
    print("REQUEST DISTRIBUTION (HOURLY)")
    print("-"*70)
    time_dist = analyze_time_distribution(data)
    for hour, count in list(time_dist.items())[-24:]:  # Last 24 hours
        print(f"{hour}: {'█' * (count // 10 or 1)} {count}")
    
    print("\n" + "="*70)

def export_csv(data: Dict, output_file: str):
    """Export analysis to CSV"""
    import csv
    
    logs = data.get('logs', [])
    
    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Timestamp', 'Tab', 'Method', 'Endpoint', 'Status', 'Duration (ms)', 'Error'])
        
        for log in logs:
            writer.writerow([
                log.get('timestamp', ''),
                log.get('tab', ''),
                log.get('method', ''),
                log.get('endpoint', ''),
                log.get('responseStatus', ''),
                log.get('duration', ''),
                log.get('error', '')
            ])
    
    print(f"\n✓ Exported to {output_file}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_requests.py <json_file>")
        print("Example: python analyze_requests.py request-tracker-2026-01-08.json")
        sys.exit(1)
    
    filepath = sys.argv[1]
    
    try:
        data = load_data(filepath)
        print_report(data)
        
        # Optionally export to CSV
        if '--csv' in sys.argv:
            csv_file = filepath.replace('.json', '.csv')
            export_csv(data, csv_file)
        
    except FileNotFoundError:
        print(f"Error: File '{filepath}' not found")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON file '{filepath}'")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
