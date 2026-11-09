#include <iostream>
#include <vector>
#include <string>
#include <numeric>

using namespace std;

int computePrefixSum(const vector<int>& nums, int limit) {
    int total = 0;
    for (int i = 0; i < (int)nums.size() && i < limit; ++i) {
        total += nums[i]; // 在此行设置断点，观察 i 与 total 的实时变化
    }
    return total;
}

int main() {
    int n = 5;
    if (!(cin >> n)) {
        n = 5;
    }

    string title = "Dream C++ GDB Debugger";
    int dp[6] = {1, 2, 4, 8, 16, 32};
    vector<int> fib = {1, 1, 2, 3, 5, 8, 13};

    int result = computePrefixSum(fib, n);
    cout << "[" << title << "] PrefixSum(" << n << ") = " << result << endl;
    return 0;
}
